import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  deriveProbeBrokerJournalRecoverySha256,
  deriveProbeBrokerJournalTransitionSha256,
  openProbeBrokerJournal,
  openProbeBrokerJournalStorageForTest,
  validateProbeBrokerJournalRecovery,
  validateProbeBrokerJournalTransition,
} from "../scripts/windows-host-falsifier/broker/journal.mjs";
import {
  acquireProbeBrokerExecutionAuthorityLease,
  releaseProbeBrokerExecutionAuthorityLease,
} from "../scripts/windows-host-falsifier/broker/execution-authority.mjs";
import type { ProbeBrokerExecutionAuthorityLease } from "../scripts/windows-host-falsifier/broker/execution-authority.mjs";
import type {
  ProbeBrokerJournal,
  ProbeBrokerJournalAuthority,
  ProbeBrokerJournalState,
} from "../scripts/windows-host-falsifier/broker/journal.mjs";
import {
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
  deriveProbePreparedBrokerEnrollmentDigest,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import type { ProbePreparedBrokerEnrollment } from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import {
  createProbeBrokerDriverValidationReceipt,
  createProbeBrokerResult,
  createProbeBrokerTask,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
} from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import type {
  ProbeBrokerDriverValidationRequest,
  ProbeBrokerRecoveryClass,
  ProbeBrokerTask,
} from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import { hashProbeCanonicalJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { deriveProbeRuntimeScenarioOperationId } from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { PROBE_RUN_PLAN } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});

interface TaskOptions {
  readonly taskId?: string;
  readonly nonceByte?: number;
  readonly rowId?: string;
  readonly variantId?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly executionRunId?: string;
  readonly issuedAt?: string;
  readonly deadline?: string;
  readonly recoveryClass?: ProbeBrokerRecoveryClass;
}

function artifact(label: string, bytes = 128) {
  const digest = sha256(label);
  return {
    blobPath: `blobs/sha256/${digest}` as const,
    bytes,
    sha256: digest,
  };
}

const preparedEnrollmentByTask = new WeakMap<ProbeBrokerTask, ProbePreparedBrokerEnrollment>();
type JournalLeaseCallbacks = {
  revalidate: () =>
    | ReturnType<typeof executionAuthoritySnapshot>
    | Promise<ReturnType<typeof executionAuthoritySnapshot>>;
  release: () => void | Promise<void>;
};
const activeJournalLeaseByEnrollment = new Map<string, ProbeBrokerExecutionAuthorityLease>();

function createPreparedJournalEnrollment(root: string) {
  const enrollmentRoot = `${root[0]?.toUpperCase()}${root.slice(1)}`;
  const brokerInstanceId = "journal-primary-broker";
  const processSidSha256 = sha256("journal-primary-user-sid");
  const volumeIdentity = sha256(`journal-volume:${enrollmentRoot.slice(0, 2).toUpperCase()}`);
  const enrollment = createProbeBrokerEnrollment({
    environmentId: "win11-current",
    brokerRole: "primary-standard-user",
    brokerInstanceId,
    mailboxRoot: `${enrollmentRoot}-mailbox`,
    mailboxAclSha256: sha256("journal-mailbox-acl"),
    journalRoot: enrollmentRoot,
    journalRootAclSha256: sha256(`${brokerInstanceId}-journal-root-acl`),
    journalDatabaseAclSha256: sha256(`${brokerInstanceId}-journal-database-acl`),
    processSidSha256,
    peerAuthoritySha256: null,
  });
  return createProbePreparedBrokerEnrollment(enrollment, {
    schemaVersion: 1,
    kind: "windows-host-probe-broker-mailbox-observation",
    brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
    environmentId: enrollment.environmentId,
    brokerRole: enrollment.brokerRole,
    brokerInstanceId: enrollment.brokerInstanceId,
    mailboxRoot: enrollment.mailboxRoot,
    mailboxSecurityProfile: enrollment.mailboxSecurityProfile,
    mailboxAclSha256: enrollment.mailboxAclSha256,
    mailboxOwnerSidSha256: processSidSha256,
    processSidSha256,
    peerAuthoritySha256: null,
    mailboxRootObjectIdentitySha256: sha256(`journal-mailbox-object:${enrollmentRoot}`),
    mailboxVolumeIdSha256: volumeIdentity,
    mailboxTransportIdentitySha256: sha256(`journal-mailbox-transport:${enrollmentRoot}`),
    mailboxFileSystem: "NTFS",
    mailboxDriveType: "fixed",
    mailboxLocalAbsolute: true,
    mailboxNetworkPath: false,
    mailboxReparsePoint: false,
    journalRoot: enrollment.journalRoot,
    journalSecurityProfile: enrollment.journalSecurityProfile,
    journalRootPathSha256: sha256(`journal-root-path:${enrollmentRoot}`),
    journalRootObjectIdentitySha256: sha256(`journal-root-object:${enrollmentRoot}`),
    journalVolumeIdSha256: volumeIdentity,
    journalRootOwnerSidSha256: processSidSha256,
    journalRootAclSha256: enrollment.journalRootAclSha256,
    journalDatabasePathSha256: sha256(`journal-database-path:${enrollmentRoot}`),
    journalDatabaseObjectIdentitySha256: sha256(`journal-database-object:${enrollmentRoot}`),
    journalDatabaseOwnerSidSha256: processSidSha256,
    journalDatabaseAclSha256: enrollment.journalDatabaseAclSha256,
    journalTransportIdentitySha256: sha256(`journal-transport:${enrollmentRoot}`),
    journalFileSystem: "NTFS",
    journalDriveType: "fixed",
    journalLocalAbsolute: true,
    journalNetworkPath: false,
    journalReparsePoint: false,
    bootIdSha256: sha256("journal-boot"),
    runnerSessionIdSha256: sha256("journal-runner-session"),
    nativeHelperSha256: sha256("journal-native-helper"),
    nativeObservationSha256: sha256(`journal-native-observation:${enrollmentRoot}`),
  });
}

function createTask(options: TaskOptions = {}, preparedEnrollment?: ProbePreparedBrokerEnrollment) {
  const definition = getProbeScenarioDefinition(
    options.rowId ?? "F-01",
    options.variantId ?? "f01-ordinary-absolute-path",
  );
  const plannedAction = definition.actions.find(
    ({ actionId }) => actionId === (options.actionId ?? "prepare-home-topology"),
  )!;
  const execution = getProbeActionMapping({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: plannedAction,
  });
  const campaignRunId = "journal-campaign-run";
  const executionRunId = options.executionRunId ?? "journal-execution-run";
  const attemptId = options.attemptId ?? "journal-attempt-a";
  const workItem = PROBE_RUN_PLAN.work.find(
    (candidate) =>
      candidate.environmentId === "win11-current" &&
      candidate.pathProfileId === "ascii" &&
      candidate.rowId === definition.rowId &&
      candidate.variantId === definition.variantId,
  )!;
  const repetition = Number.isSafeInteger(plannedAction.parameters.repetition)
    ? (plannedAction.parameters.repetition as number)
    : null;
  const expectedActor = {
    role: "primary-standard-user" as const,
    identitySource: "actors.primaryStandardUserSidSha256" as const,
    identitySha256: sha256("journal-primary-user-sid"),
  };
  const operationId = deriveProbeRuntimeScenarioOperationId(
    {
      campaignRunId,
      attemptId,
      workId: workItem.workId,
      ...(repetition === null ? {} : { repetition }),
    },
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
  const requestArtifact = artifact(`journal-driver-request:${attemptId}:${plannedAction.actionId}`);

  const task = createProbeBrokerTask(
    {
      taskId: options.taskId ?? `journal-task-${attemptId}`,
      controllerIdentitySha256: sha256("journal-controller-identity"),
      controllerPublicKeySha256: sha256(controllerPublicKeyBytes),
      candidateSha256: sha256("journal-candidate"),
      runAuthorizationClaimReceiptSha256: sha256("journal-run-authorization"),
      coordinate: {
        campaignRunId,
        executionRunId,
        attemptId,
        workId: workItem.workId,
        environmentId: "win11-current",
        pathProfileId: "ascii",
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
      actorSelectorInput: null,
      expectedActor,
      brokerEnrollmentSha256:
        preparedEnrollment?.brokerEnrollmentSha256 ?? sha256("journal-broker-enrollment"),
      brokerInstanceId: "journal-primary-broker",
      brokerRole: "primary-standard-user",
      mailboxAclSha256: sha256("journal-mailbox-acl"),
      processSidSha256: expectedActor.identitySha256,
      bootIdSha256: sha256("journal-boot"),
      runnerSessionIdSha256: sha256("journal-runner-session"),
      driverRequest: {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-driver-request",
        driverId: execution.driverId,
        requestArtifact,
      },
      recoveryClass: options.recoveryClass ?? "inspect-and-reconcile",
      issuedAt: options.issuedAt ?? "2098-12-31T23:55:00.000Z",
      deadline: options.deadline ?? "2099-01-01T00:00:00.000Z",
      nonceBase64: Buffer.alloc(32, options.nonceByte ?? 7).toString("base64"),
    },
    (digest) => sign(null, digest, controllerKeys.privateKey),
  );
  if (preparedEnrollment !== undefined) preparedEnrollmentByTask.set(task, preparedEnrollment);
  return task;
}

function createJournalTask(root: string, options: TaskOptions = {}) {
  return process.platform === "win32"
    ? createTask(options, createPreparedJournalEnrollment(root))
    : createTask(options);
}

function authorityFor(task: ProbeBrokerTask): ProbeBrokerJournalAuthority {
  const snapshot = executionAuthoritySnapshot(task);
  return Object.fromEntries(
    [
      "controllerIdentitySha256",
      "controllerPublicKeySha256",
      "brokerEnrollmentSha256",
      "preparedBrokerEnrollmentSha256",
      "brokerInstanceId",
      "brokerRole",
      "mailboxRootObjectIdentitySha256",
      "mailboxVolumeIdSha256",
      "mailboxTransportIdentitySha256",
      "mailboxAclSha256",
      "mailboxOwnerSidSha256",
      "journalRootPathSha256",
      "journalRootObjectIdentitySha256",
      "journalVolumeIdSha256",
      "journalRootOwnerSidSha256",
      "journalRootAclSha256",
      "journalDatabasePathSha256",
      "journalDatabaseObjectIdentitySha256",
      "journalDatabaseOwnerSidSha256",
      "journalDatabaseAclSha256",
      "journalTransportIdentitySha256",
      "processSidSha256",
      "bootIdSha256",
      "runnerSessionIdSha256",
      "nativeObservationSha256",
    ].map((key) => [key, snapshot[key as keyof typeof snapshot]]),
  ) as unknown as ProbeBrokerJournalAuthority;
}

function executionAuthoritySnapshot(
  task: ProbeBrokerTask,
  journalRoot = preparedEnrollmentByTask.get(task)?.journalRoot ?? "/tmp/journal-placeholder",
) {
  const preparedEnrollment = preparedEnrollmentByTask.get(task);
  return {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-broker-execution-authority" as const,
    preparedRunGenerationSha256: sha256(`journal-generation:${task.coordinate.executionRunId}`),
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
    preparedBrokerEnrollmentSha256:
      preparedEnrollment?.preparedBrokerEnrollmentSha256 ??
      sha256(`prepared:${task.brokerEnrollmentSha256}`),
    brokerInstanceId: task.brokerInstanceId,
    brokerRole: task.brokerRole,
    mailboxRootObjectIdentitySha256:
      preparedEnrollment?.mailboxRootObjectIdentitySha256 ??
      sha256(`${task.brokerInstanceId}-mailbox-object`),
    mailboxVolumeIdSha256:
      preparedEnrollment?.mailboxVolumeIdSha256 ??
      sha256(`${task.brokerInstanceId}-mailbox-volume`),
    mailboxTransportIdentitySha256:
      preparedEnrollment?.mailboxTransportIdentitySha256 ??
      sha256(`${task.brokerInstanceId}-mailbox-transport`),
    mailboxAclSha256: task.mailboxAclSha256,
    mailboxOwnerSidSha256: preparedEnrollment?.mailboxOwnerSidSha256 ?? task.processSidSha256,
    journalRoot,
    journalSecurityProfile: "role-separated-append-only-journal-v1" as const,
    journalRootPathSha256:
      preparedEnrollment?.journalRootPathSha256 ??
      sha256(`${task.brokerInstanceId}-journal-root-path`),
    journalRootObjectIdentitySha256:
      preparedEnrollment?.journalRootObjectIdentitySha256 ??
      sha256(`${task.brokerInstanceId}-journal-root-object`),
    journalVolumeIdSha256:
      preparedEnrollment?.journalVolumeIdSha256 ??
      sha256(`${task.brokerInstanceId}-journal-volume`),
    journalRootOwnerSidSha256:
      preparedEnrollment?.journalRootOwnerSidSha256 ??
      sha256(`${task.brokerInstanceId}-journal-root-owner`),
    journalRootAclSha256:
      preparedEnrollment?.journalRootAclSha256 ??
      sha256(`${task.brokerInstanceId}-journal-root-acl`),
    journalDatabasePathSha256:
      preparedEnrollment?.journalDatabasePathSha256 ??
      sha256(`${task.brokerInstanceId}-journal-database-path`),
    journalDatabaseObjectIdentitySha256:
      preparedEnrollment?.journalDatabaseObjectIdentitySha256 ??
      sha256(`${task.brokerInstanceId}-journal-database-object`),
    journalDatabaseOwnerSidSha256:
      preparedEnrollment?.journalDatabaseOwnerSidSha256 ??
      sha256(`${task.brokerInstanceId}-journal-database-owner`),
    journalDatabaseAclSha256:
      preparedEnrollment?.journalDatabaseAclSha256 ??
      sha256(`${task.brokerInstanceId}-journal-database-acl`),
    journalTransportIdentitySha256:
      preparedEnrollment?.journalTransportIdentitySha256 ??
      sha256(`${task.brokerInstanceId}-journal-transport`),
    processSidSha256: task.processSidSha256,
    bootIdSha256: task.bootIdSha256,
    runnerSessionIdSha256: task.runnerSessionIdSha256,
    nativeObservationSha256:
      preparedEnrollment?.nativeObservationSha256 ??
      sha256(`${task.brokerInstanceId}-native-observation`),
    peerAuthoritySha256: preparedEnrollment?.peerAuthoritySha256 ?? null,
  };
}

async function acceptanceOptions(
  task: ProbeBrokerTask,
  verificationInstant = new Date("2098-12-31T23:59:59.000Z"),
  overrides: {
    readonly authority?: ReturnType<typeof executionAuthoritySnapshot>;
    readonly revalidate?: () =>
      | ReturnType<typeof executionAuthoritySnapshot>
      | Promise<ReturnType<typeof executionAuthoritySnapshot>>;
    readonly release?: () => void | Promise<void>;
    readonly validateDriverRequest?: (
      request: ProbeBrokerDriverValidationRequest,
    ) =>
      | ReturnType<typeof createProbeBrokerDriverValidationReceipt>
      | Promise<ReturnType<typeof createProbeBrokerDriverValidationReceipt>>;
  } = {},
) {
  const authority = overrides.authority ?? executionAuthoritySnapshot(task);
  let executionAuthorityLease: ProbeBrokerExecutionAuthorityLease;
  if (process.platform === "win32") {
    const capturedLease = activeJournalLeaseByEnrollment.get(task.brokerEnrollmentSha256);
    if (capturedLease === undefined) {
      throw new Error("a prepared Windows journal must be open before accepting a task");
    }
    if (overrides.revalidate !== undefined || overrides.release !== undefined) {
      throw new Error("Windows journal lease callbacks must be installed before opening storage");
    }
    executionAuthorityLease = capturedLease;
  } else {
    executionAuthorityLease = await acquireProbeBrokerExecutionAuthorityLease({
      acquire: async () => authority,
      revalidate: overrides.revalidate ?? (async () => authority),
      release: overrides.release ?? (async () => {}),
    });
  }
  return {
    controllerPublicKeyBytes,
    executionAuthorityLease,
    validateDriverRequest:
      overrides.validateDriverRequest ??
      (async (request: ProbeBrokerDriverValidationRequest) =>
        createProbeBrokerDriverValidationReceipt({
          taskSha256: request.taskSha256,
          driverId: request.driverId,
          requestArtifactSha256: request.requestArtifact.sha256,
          requestArtifactBytes: request.requestArtifact.bytes,
          requestSchemaSha256: sha256(`journal-driver-schema:${request.driverId}`),
          recoveryClass: task.recoveryClass,
        })),
    verificationInstant,
  };
}

function createResult(task: ProbeBrokerTask, label = "result") {
  const proof = artifact(`journal-proof:${label}`);
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
      driverId: task.driverRequest.driverId,
      resultArtifact: artifact(`journal-driver-result:${label}`),
    },
    proofArtifacts: [proof],
    observerTranscripts: [
      {
        ...artifact(`journal-observer:${label}`),
        transcriptSha256: sha256(`journal-observer-transcript:${label}`),
      },
    ],
    pausedSessionReceipt: proof,
  });
}

const roots: string[] = [];
const journals: ProbeBrokerJournal[] = [];
const journalAuthorityLeases: ProbeBrokerExecutionAuthorityLease[] = [];

async function createRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enduragent-broker-journal-")));
  roots.push(root);
  return root;
}

async function openJournalWithSnapshot(
  root: string,
  snapshot: ReturnType<typeof executionAuthoritySnapshot>,
  preparedEnrollment?: ProbePreparedBrokerEnrollment,
  leaseCallbacks: Partial<JournalLeaseCallbacks> = {},
) {
  const executionAuthorityLease = await acquireProbeBrokerExecutionAuthorityLease({
    acquire: async () => snapshot,
    revalidate: leaseCallbacks.revalidate ?? (async () => snapshot),
    release: leaseCallbacks.release ?? (async () => {}),
  });
  try {
    let journal: ProbeBrokerJournal;
    if (process.platform === "win32") {
      if (preparedEnrollment === undefined) {
        throw new Error("Windows journal tests require a prepared enrollment");
      }
      journal = await openProbeBrokerJournal({
        root,
        preparedBrokerEnrollment: preparedEnrollment,
        executionAuthorityLease,
      });
    } else {
      journal = await openProbeBrokerJournalStorageForTest({
        root,
        executionAuthorityLease,
      });
    }
    journals.push(journal);
    journalAuthorityLeases.push(executionAuthorityLease);
    if (preparedEnrollment !== undefined) {
      activeJournalLeaseByEnrollment.set(
        preparedEnrollment.brokerEnrollmentSha256,
        executionAuthorityLease,
      );
    }
    return journal;
  } catch (error) {
    await releaseProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
    throw error;
  }
}

async function openJournal(
  root: string,
  task: ProbeBrokerTask,
  leaseCallbacks: Partial<JournalLeaseCallbacks> = {},
) {
  return openJournalWithSnapshot(
    root,
    executionAuthoritySnapshot(task, root),
    preparedEnrollmentByTask.get(task),
    leaseCallbacks,
  );
}

async function reopenJournalForTest(root: string, task: ProbeBrokerTask) {
  return openJournal(root, task);
}

afterEach(async () => {
  await Promise.allSettled(journals.splice(0).map((journal) => journal.close()));
  await Promise.allSettled(
    journalAuthorityLeases
      .splice(0)
      .map((lease) => releaseProbeBrokerExecutionAuthorityLease(lease)),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  activeJournalLeaseByEnrollment.clear();
});

describe("Windows host probe broker journal test storage", () => {
  it.runIf(process.platform === "win32")(
    "refuses the ACL-unprepared storage harness on Windows",
    async () => {
      const task = createTask();
      const root = await createRoot();
      const snapshot = executionAuthoritySnapshot(task, root);
      const executionAuthorityLease = await acquireProbeBrokerExecutionAuthorityLease({
        acquire: async () => snapshot,
        revalidate: async () => snapshot,
        release: async () => {},
      });

      try {
        await expect(
          openProbeBrokerJournalStorageForTest({ root, executionAuthorityLease }),
        ).rejects.toMatchObject({ code: "BROKER_JOURNAL_TEST_ONLY" });
      } finally {
        await releaseProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
      }
    },
  );
});

describe("Windows host probe broker journal", () => {
  it.runIf(process.platform === "win32")(
    "rejects prepared authority drift and another acceptance lease",
    async () => {
      const root = await createRoot();
      const task = createJournalTask(root);
      const preparedEnrollment = preparedEnrollmentByTask.get(task)!;
      const snapshot = executionAuthoritySnapshot(task, root);
      const driftFields = {
        ...preparedEnrollment,
        nativeObservationSha256: sha256("drifted-prepared-native-observation"),
      };
      const driftedEnrollment = {
        ...driftFields,
        preparedBrokerEnrollmentSha256: deriveProbePreparedBrokerEnrollmentDigest(driftFields),
      };
      const driftLease = await acquireProbeBrokerExecutionAuthorityLease({
        acquire: async () => snapshot,
        revalidate: async () => snapshot,
        release: async () => {},
      });
      try {
        await expect(
          openProbeBrokerJournal({
            root,
            preparedBrokerEnrollment: driftedEnrollment,
            executionAuthorityLease: driftLease,
          }),
        ).rejects.toMatchObject({ code: "BROKER_JOURNAL_LIVE_AUTHORITY" });
      } finally {
        await releaseProbeBrokerExecutionAuthorityLease(driftLease);
      }

      const journal = await openJournal(root, task);
      const anotherLease = await acquireProbeBrokerExecutionAuthorityLease({
        acquire: async () => snapshot,
        revalidate: async () => snapshot,
        release: async () => {},
      });
      const options = await acceptanceOptions(task);
      try {
        await expect(
          journal.acceptTask(task, {
            ...options,
            executionAuthorityLease: anotherLease,
          }),
        ).rejects.toMatchObject({ code: "BROKER_JOURNAL_LIVE_AUTHORITY" });
      } finally {
        await releaseProbeBrokerExecutionAuthorityLease(anotherLease);
      }
    },
  );

  it("pins WAL/FULL storage and rejects copied authority metadata", async () => {
    const root = await createRoot();
    const task = createJournalTask(root);
    const journal = await openJournal(root, task);

    expect(await journal.scan()).toMatchObject({
      schemaVersion: 1,
      kind: "windows-host-probe-broker-journal-scan",
      journalMode: "wal",
      lockingMode: "exclusive",
      synchronous: "FULL",
      tasks: [],
    });
    await journal.close();

    if (process.platform !== "win32") {
      const authority = authorityFor(task);
      const snapshot = executionAuthoritySnapshot(task, root);
      for (const key of Object.keys(authority) as (keyof ProbeBrokerJournalAuthority)[]) {
        const changedSnapshot = {
          ...snapshot,
          [key]:
            key === "brokerRole"
              ? "second-user"
              : key === "brokerInstanceId"
                ? "another-broker-instance"
                : sha256(`changed:${key}`),
        } as ReturnType<typeof executionAuthoritySnapshot>;
        await expect(openJournalWithSnapshot(root, changedSnapshot)).rejects.toMatchObject({
          code: "BROKER_JOURNAL_AUTHORITY",
        });
      }
    }

    const copiedRoot = await createRoot();
    await copyFile(join(root, "broker-journal.sqlite"), join(copiedRoot, "broker-journal.sqlite"));
    if (process.platform === "win32") {
      await expect(openJournal(copiedRoot, createJournalTask(copiedRoot))).rejects.toMatchObject({
        code: "BROKER_JOURNAL_AUTHORITY",
      });
    } else {
      await expect(
        openJournalWithSnapshot(copiedRoot, {
          ...executionAuthoritySnapshot(task, copiedRoot),
          runnerSessionIdSha256: sha256("copied-under-another-session"),
        }),
      ).rejects.toMatchObject({ code: "BROKER_JOURNAL_AUTHORITY" });
    }
  });

  it("accepts an exact envelope once and rejects equivocation and global identity reuse", async () => {
    const root = await createRoot();
    const task = createJournalTask(root);
    let journal = await openJournal(root, task);

    const fresh = await journal.acceptTask(task, await acceptanceOptions(task));
    const retained = await journal.acceptTask(task, await acceptanceOptions(task));
    expect(fresh.capability.replayJournalDisposition).toBe("accepted");
    expect(retained.capability.replayJournalDisposition).toBe("idempotent-replay");
    expect(retained.capability.replayJournalEntrySha256).toBe(
      fresh.capability.replayJournalEntrySha256,
    );
    expect((await journal.scan()).tasks).toHaveLength(1);

    await journal.close();
    const equivocation = createJournalTask(root, {
      taskId: "equivocating-envelope",
      nonceByte: 8,
    });
    journal = await openJournal(root, equivocation);
    await expect(
      journal.acceptTask(equivocation, await acceptanceOptions(equivocation)),
    ).rejects.toMatchObject({ code: "BROKER_PROTOCOL_EQUIVOCATION" });

    await journal.close();
    const reusedTaskId = createJournalTask(root, {
      taskId: task.taskId,
      nonceByte: 9,
      attemptId: "journal-attempt-reused-task-id",
    });
    journal = await openJournal(root, reusedTaskId);
    await expect(
      journal.acceptTask(reusedTaskId, await acceptanceOptions(reusedTaskId)),
    ).rejects.toMatchObject({ code: "BROKER_JOURNAL_IDENTITY_REUSE" });

    await journal.close();
    const reusedNonce = createJournalTask(root, {
      taskId: "journal-task-reused-nonce",
      nonceByte: 7,
      attemptId: "journal-attempt-reused-nonce",
    });
    journal = await openJournal(root, reusedNonce);
    await expect(
      journal.acceptTask(reusedNonce, await acceptanceOptions(reusedNonce)),
    ).rejects.toMatchObject({ code: "BROKER_JOURNAL_IDENTITY_REUSE" });
    expect((await journal.scan()).tasks).toHaveLength(1);
  });

  it("deduplicates a physical operation across execution authority generations", async () => {
    const root = await createRoot();
    const first = createJournalTask(root, {
      taskId: "journal-physical-operation-a",
      nonceByte: 40,
      executionRunId: "journal-execution-run-a",
    });
    const renewedAuthority = createJournalTask(root, {
      taskId: "journal-physical-operation-b",
      nonceByte: 41,
      executionRunId: "journal-execution-run-b",
    });
    expect(deriveProbeBrokerTaskSemanticKeySha256(first)).not.toBe(
      deriveProbeBrokerTaskSemanticKeySha256(renewedAuthority),
    );
    expect(deriveProbeBrokerTaskPhysicalOperationKeySha256(first)).toBe(
      deriveProbeBrokerTaskPhysicalOperationKeySha256(renewedAuthority),
    );

    let journal = await openJournal(root, first);
    const accepted = await journal.acceptTask(first, await acceptanceOptions(first));
    expect((await journal.authorizeEffect(accepted)).authorized).toBe(true);

    await journal.close();
    journal = await openJournal(root, renewedAuthority);
    await expect(
      journal.acceptTask(renewedAuthority, await acceptanceOptions(renewedAuthority)),
    ).rejects.toMatchObject({ code: "BROKER_PROTOCOL_EQUIVOCATION" });
    const [record] = (await journal.scan()).tasks;
    expect(record).toMatchObject({
      semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(first),
      physicalOperationKeySha256: deriveProbeBrokerTaskPhysicalOperationKeySha256(first),
      currentState: "effect-started",
    });
  });

  it("returns absent for expired unretained work but permits exact retained replay", async () => {
    const root = await createRoot();
    const expired = createJournalTask(root, {
      taskId: "journal-expired-task",
      nonceByte: 10,
      attemptId: "journal-attempt-expired",
    });
    let journal = await openJournal(root, expired);

    await expect(
      journal.acceptTask(
        expired,
        await acceptanceOptions(expired, new Date("2100-01-01T00:00:00.000Z")),
      ),
    ).rejects.toMatchObject({ code: "BROKER_PROTOCOL_DEADLINE" });
    expect((await journal.scan()).tasks).toHaveLength(0);

    await journal.close();
    const retainedTask = createJournalTask(root, {
      taskId: "journal-retained-expired-task",
      nonceByte: 11,
      attemptId: "journal-attempt-retained-expired",
    });
    journal = await openJournal(root, retainedTask);
    await journal.acceptTask(retainedTask, await acceptanceOptions(retainedTask));
    const afterDeadline = await journal.acceptTask(
      retainedTask,
      await acceptanceOptions(retainedTask, new Date("2100-01-01T00:00:00.000Z")),
    );
    expect(afterDeadline.capability.replayJournalDisposition).toBe("idempotent-replay");
    expect(afterDeadline.recoveryDirective).toBe("reconcile");
  });

  it("recovers every durable boundary without authorizing a second unsafe effect", async () => {
    const boundaries: readonly ProbeBrokerJournalState[] = [
      "accepted",
      "effect-started",
      "effect-committed",
      "result-retained",
    ];

    for (const [index, boundary] of boundaries.entries()) {
      const root = await createRoot();
      const task = createJournalTask(root, {
        taskId: `journal-crash-${boundary}`,
        nonceByte: 20 + index,
        attemptId: `journal-attempt-crash-${boundary}`,
      });
      const beforeCrash = await openJournal(root, task);
      const accepted = await beforeCrash.acceptTask(task, await acceptanceOptions(task));
      const effectSha256 = sha256(`journal-effect:${boundary}`);
      const result = createResult(task, boundary);

      if (boundary !== "accepted") {
        expect((await beforeCrash.authorizeEffect(accepted)).authorized).toBe(true);
      }
      if (boundary === "effect-committed" || boundary === "result-retained") {
        await beforeCrash.recordEffectCommitted({
          acceptedContext: accepted,
          effectSha256,
        });
      }
      if (boundary === "result-retained") {
        await beforeCrash.recordResultRetained({ acceptedContext: accepted, result });
      }
      await beforeCrash.close();

      const afterCrash = await openJournal(root, task);
      const replayed = await afterCrash.acceptTask(task, await acceptanceOptions(task));
      const recovery = await afterCrash.recover(replayed);
      expect(recovery.currentState).toBe(boundary);
      expect(recovery.orchestrationDirective).toBe(
        boundary === "accepted"
          ? "execute"
          : boundary === "result-retained"
            ? "replay-retained-result"
            : "reconcile",
      );

      const firstAuthorization = await afterCrash.authorizeEffect(replayed);
      expect(firstAuthorization.authorized).toBe(boundary === "accepted");
      const secondAuthorization = await afterCrash.authorizeEffect(replayed);
      expect(secondAuthorization.authorized).toBe(false);

      if (boundary === "result-retained") {
        expect(await afterCrash.readRetainedResult(replayed)).toEqual(result);
        expect(await afterCrash.readRetainedCompletion(replayed)).toEqual({
          result,
          controllerAcceptanceInput: expect.objectContaining({
            brokerTaskSha256: task.taskSha256,
            brokerResultSha256: result.resultSha256,
            replayJournalDisposition: "accepted",
            replayJournalEntrySha256: replayed.capability.replayJournalEntrySha256,
          }),
        });
      } else {
        expect(await afterCrash.readRetainedResult(replayed)).toBeNull();
        expect(await afterCrash.readRetainedCompletion(replayed)).toBeNull();
      }
    }
  });

  it("serializes competing journal handles until the active handle closes", async () => {
    const root = await createRoot();
    const task = createJournalTask(root, {
      taskId: "journal-concurrent-task",
      nonceByte: 30,
      attemptId: "journal-attempt-concurrent",
    });
    const left = await openJournal(root, task);
    const leftOptions = await acceptanceOptions(task);
    await left.acceptTask(task, leftOptions);

    await expect(openJournal(root, task)).rejects.toMatchObject({
      code: "BROKER_JOURNAL_SQLITE",
    });

    await left.close();
    await releaseProbeBrokerExecutionAuthorityLease(leftOptions.executionAuthorityLease);
    const right = await openJournal(root, task);
    const rightOptions = await acceptanceOptions(task);
    const rightContext = await right.acceptTask(task, rightOptions);
    expect(rightContext.capability.replayJournalDisposition).toBe("idempotent-replay");
    await right.close();
    await releaseProbeBrokerExecutionAuthorityLease(rightOptions.executionAuthorityLease);
  });

  it("requires a fresh live lease for a later physical operation", async () => {
    const root = await createRoot();
    const first = createJournalTask(root, {
      taskId: "journal-single-lease-sequential-first",
      nonceByte: 51,
      rowId: "F-03",
      variantId: "f03-port-inspect-create-swap",
      actionId: "prepare-private-file-target",
    });
    const second = createJournalTask(root, {
      taskId: "journal-single-lease-sequential-second",
      nonceByte: 52,
      rowId: "F-03",
      variantId: "f03-port-inspect-create-swap",
      actionId: "arm-inspect-create-swap",
    });
    expect(deriveProbeBrokerTaskPhysicalOperationKeySha256(first)).not.toBe(
      deriveProbeBrokerTaskPhysicalOperationKeySha256(second),
    );
    let journal = await openJournal(root, first);
    const options = await acceptanceOptions(first);
    const context = await journal.acceptTask(first, options);
    expect((await journal.authorizeEffect(context)).authorized).toBe(true);
    await journal.recordEffectCommitted({
      acceptedContext: context,
      effectSha256: sha256("journal-single-lease-sequential-effect"),
    });
    await journal.recordResultRetained({ acceptedContext: context, result: createResult(first) });

    await expect(journal.acceptTask(second, options)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_OPERATION_BINDING",
    });
    await releaseProbeBrokerExecutionAuthorityLease(options.executionAuthorityLease);

    await journal.close();
    journal = await openJournal(root, second);
    const secondOptions = await acceptanceOptions(second);
    const secondContext = await journal.acceptTask(second, secondOptions);
    expect(secondContext.capability.replayJournalDisposition).toBe("accepted");
    expect((await journal.authorizeEffect(secondContext)).authorized).toBe(true);
    await journal.recordEffectCommitted({
      acceptedContext: secondContext,
      effectSha256: sha256("journal-single-lease-second-effect"),
    });
    await journal.recordResultRetained({
      acceptedContext: secondContext,
      result: createResult(second),
    });
    await releaseProbeBrokerExecutionAuthorityLease(secondOptions.executionAuthorityLease);
  });

  it("cannot overlap two physical operations on one live lease", async () => {
    const root = await createRoot();
    const first = createJournalTask(root, {
      taskId: "journal-single-lease-overlap-first",
      nonceByte: 53,
      rowId: "F-03",
      variantId: "f03-port-inspect-create-swap",
      actionId: "prepare-private-file-target",
    });
    const second = createJournalTask(root, {
      taskId: "journal-single-lease-overlap-second",
      nonceByte: 54,
      rowId: "F-03",
      variantId: "f03-port-inspect-create-swap",
      actionId: "arm-inspect-create-swap",
    });
    const journal = await openJournal(root, first);
    const options = await acceptanceOptions(first);
    await journal.acceptTask(first, options);

    await expect(journal.acceptTask(second, options)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_OPERATION_BINDING",
    });
    await releaseProbeBrokerExecutionAuthorityLease(options.executionAuthorityLease);
  });

  it("enforces ordered idempotent transitions and exact retained results", async () => {
    const root = await createRoot();
    const task = createJournalTask(root, {
      taskId: "journal-transition-task",
      nonceByte: 31,
      attemptId: "journal-attempt-transitions",
    });
    const journal = await openJournal(root, task);
    const context = await journal.acceptTask(task, await acceptanceOptions(task));
    const effectSha256 = sha256("journal-effect-commitment");

    await expect(
      journal.recordEffectCommitted({ acceptedContext: context, effectSha256 }),
    ).rejects.toMatchObject({ code: "BROKER_JOURNAL_TRANSITION_ORDER" });
    await expect(
      journal.recordResultRetained({ acceptedContext: context, result: createResult(task) }),
    ).rejects.toMatchObject({ code: "BROKER_JOURNAL_TRANSITION_ORDER" });

    expect((await journal.authorizeEffect(context)).authorized).toBe(true);
    expect(
      await journal.recordEffectCommitted({ acceptedContext: context, effectSha256 }),
    ).toMatchObject({ created: true });
    expect(
      await journal.recordEffectCommitted({ acceptedContext: context, effectSha256 }),
    ).toMatchObject({ created: false });
    await expect(
      journal.recordEffectCommitted({
        acceptedContext: context,
        effectSha256: sha256("another-effect"),
      }),
    ).rejects.toMatchObject({ code: "BROKER_JOURNAL_TRANSITION_CONFLICT" });

    const result = createResult(task);
    expect(await journal.recordResultRetained({ acceptedContext: context, result })).toMatchObject({
      created: true,
    });
    expect(await journal.recordResultRetained({ acceptedContext: context, result })).toMatchObject({
      created: false,
    });
    await expect(
      journal.recordResultRetained({
        acceptedContext: context,
        result: createResult(task, "conflict"),
      }),
    ).rejects.toMatchObject({ code: "BROKER_JOURNAL_TRANSITION_CONFLICT" });
    expect(await journal.readRetainedResult(context)).toEqual(result);

    const record = (await journal.scan()).tasks[0]!;
    expect(record.transitions.map(({ state }) => state)).toEqual([
      "accepted",
      "effect-started",
      "effect-committed",
      "result-retained",
    ]);
    expect(record.transitions.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(record.transitions[1]?.previousRecordSha256).toBe(record.transitions[0]?.recordSha256);
    expect(record.transitions[2]?.previousRecordSha256).toBe(record.transitions[1]?.recordSha256);
    expect(record.transitions[3]?.previousRecordSha256).toBe(record.transitions[2]?.recordSha256);
  });

  it("rejects authority drift before journal consumption without retaining the task", async () => {
    const root = await createRoot();
    const task = createJournalTask(root, { attemptId: "drift-before-consumption" });
    let current = executionAuthoritySnapshot(task, root);
    const revalidate = () => current;
    const journal = await openJournal(root, task, { revalidate });
    const options = await acceptanceOptions(task, undefined, {
      authority: current,
      ...(process.platform === "win32" ? {} : { revalidate }),
      validateDriverRequest: async (request) => {
        current = {
          ...current,
          nativeObservationSha256: sha256("drifted-native-observation"),
        };
        return createProbeBrokerDriverValidationReceipt({
          taskSha256: request.taskSha256,
          driverId: request.driverId,
          requestArtifactSha256: request.requestArtifact.sha256,
          requestArtifactBytes: request.requestArtifact.bytes,
          requestSchemaSha256: sha256(`journal-driver-schema:${request.driverId}`),
          recoveryClass: task.recoveryClass,
        });
      },
    });

    await expect(journal.acceptTask(task, options)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_DRIFT",
    });
    expect((await journal.scan()).tasks).toEqual([]);
    await releaseProbeBrokerExecutionAuthorityLease(options.executionAuthorityLease);
  });

  it("keeps post-effect authority loss conservative and never authorizes a second effect", async () => {
    const root = await createRoot();
    const task = createJournalTask(root, { attemptId: "post-effect-authority-loss" });
    const original = executionAuthoritySnapshot(task, root);
    let current = original;
    const revalidate = () => current;
    let journal = await openJournal(root, task, { revalidate });
    const firstOptions = await acceptanceOptions(task, undefined, {
      authority: original,
      ...(process.platform === "win32" ? {} : { revalidate }),
    });
    const context = await journal.acceptTask(task, firstOptions);
    expect((await journal.authorizeEffect(context)).authorized).toBe(true);

    current = { ...original, bootIdSha256: sha256("boot-after-authority-loss") };
    await expect(
      journal.recordEffectCommitted({
        acceptedContext: context,
        effectSha256: sha256("effect-after-authority-loss"),
      }),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
    expect((await journal.scan()).tasks[0]?.currentState).toBe("effect-started");
    await expect(
      releaseProbeBrokerExecutionAuthorityLease(firstOptions.executionAuthorityLease),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_INCOMPLETE" });
    await journal.close();

    current = original;
    journal = await openJournal(root, task, { revalidate });
    const replacementOptions = await acceptanceOptions(task, undefined, {
      authority: original,
      ...(process.platform === "win32" ? {} : { revalidate }),
    });
    const replayed = await journal.acceptTask(task, replacementOptions);
    expect(replayed.capability.replayJournalDisposition).toBe("idempotent-replay");
    const authorization = await journal.authorizeEffect(replayed);
    expect(authorization).toMatchObject({
      authorized: false,
      record: { currentState: "effect-started" },
      recovery: { orchestrationDirective: "reconcile" },
    });
    expect((await journal.scan()).tasks[0]?.transitions).toHaveLength(2);
    await expect(
      releaseProbeBrokerExecutionAuthorityLease(replacementOptions.executionAuthorityLease),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_INCOMPLETE" });
    await journal.recordEffectCommitted({
      acceptedContext: replayed,
      effectSha256: sha256("reconciled-effect-after-authority-loss"),
    });
    await journal.recordResultRetained({
      acceptedContext: replayed,
      result: createResult(task),
    });
    await releaseProbeBrokerExecutionAuthorityLease(replacementOptions.executionAuthorityLease);
  });

  it("requires the bound live lease for transitions and retained-result reads", async () => {
    const root = await createRoot();
    const task = createJournalTask(root, { attemptId: "released-authority-lease" });
    const journal = await openJournal(root, task);
    const options = await acceptanceOptions(task);
    const context = await journal.acceptTask(task, options);
    await releaseProbeBrokerExecutionAuthorityLease(options.executionAuthorityLease);

    await expect(journal.authorizeEffect(context)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_RELEASED",
    });
    await expect(journal.readRetainedResult(context)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_RELEASED",
    });
    expect((await journal.scan()).tasks[0]?.currentState).toBe("accepted");
  });

  it("validates closed canonical transition and recovery schemas with domain hashes", async () => {
    const root = await createRoot();
    const task = createJournalTask(root, {
      taskId: "journal-schema-task",
      nonceByte: 32,
      attemptId: "journal-attempt-schema",
    });
    const journal = await openJournal(root, task);
    const context = await journal.acceptTask(task, await acceptanceOptions(task));
    const transition = (await journal.scan()).tasks[0]!.transitions[0]!;
    const recovery = await journal.recover(context);

    expect(validateProbeBrokerJournalTransition(transition)).toEqual(transition);
    expect(deriveProbeBrokerJournalTransitionSha256(transition)).toBe(transition.recordSha256);
    expect(validateProbeBrokerJournalRecovery(recovery)).toEqual(recovery);
    expect(deriveProbeBrokerJournalRecoverySha256(recovery)).toBe(recovery.recoverySha256);
    expect(transition.recordSha256).not.toBe(recovery.recoverySha256);

    expect(() => validateProbeBrokerJournalTransition({ ...transition, extra: true })).toThrowError(
      expect.objectContaining({ code: "BROKER_JOURNAL_SCHEMA" }),
    );
    expect(() =>
      validateProbeBrokerJournalRecovery({
        ...recovery,
        orchestrationDirective: "manual-intervention",
      }),
    ).toThrowError(expect.objectContaining({ code: "BROKER_JOURNAL_RECOVERY" }));

    const accessor = { ...transition } as Record<string, unknown>;
    Object.defineProperty(accessor, "state", {
      enumerable: true,
      get: () => "accepted",
    });
    expect(() => validateProbeBrokerJournalTransition(accessor)).toThrowError(
      expect.objectContaining({ code: "BROKER_JOURNAL_VALUE" }),
    );
  });

  it("rejects append-only writes and any noncanonical database object", async () => {
    const root = await createRoot();
    const task = createJournalTask(root, {
      taskId: "journal-database-schema-task",
      nonceByte: 33,
      attemptId: "journal-attempt-database-schema",
    });
    const journal = await openJournal(root, task);
    await journal.acceptTask(task, await acceptanceOptions(task));
    await journal.close();

    const database = new DatabaseSync(join(root, "broker-journal.sqlite"));
    expect(database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).toMatchObject(
      { journal_mode: "wal" },
    );
    expect(() => database.exec("UPDATE broker_tasks SET task_id = 'rewritten'")).toThrowError(
      /append-only/u,
    );
    database.exec("CREATE TABLE unexpected_object (value TEXT) STRICT");
    database.close();

    await expect(reopenJournalForTest(root, task)).rejects.toMatchObject({
      code: "BROKER_JOURNAL_DATABASE_SCHEMA",
    });
  });

  it.each(["broker_transitions", "broker_results"] as const)(
    "rejects an orphan row injected into %s with foreign-key enforcement disabled",
    async (table) => {
      const tableId = table.replaceAll("_", "-");
      const root = await createRoot();
      const task = createJournalTask(root, {
        taskId: `journal-orphan-${tableId}`,
        nonceByte: table === "broker_transitions" ? 34 : 35,
        attemptId: `journal-attempt-orphan-${tableId}`,
      });
      const journal = await openJournal(root, task);
      await journal.close();

      const semanticKeySha256 = sha256(`orphan-semantic:${table}`);
      const physicalOperationKeySha256 = sha256(`orphan-physical:${table}`);
      const database = new DatabaseSync(join(root, "broker-journal.sqlite"));
      database.exec("PRAGMA foreign_keys = OFF");
      if (table === "broker_transitions") {
        database
          .prepare(
            [
              "INSERT INTO broker_transitions",
              "(semantic_key_sha256, physical_operation_key_sha256, sequence, state,",
              " capability_sha256, accepted_context_sha256, protocol_recovery_directive,",
              " artifact_sha256, previous_record_sha256, record_sha256, record_json)",
              "VALUES (?, ?, 1, 'accepted', ?, ?, 'execute', NULL, NULL, ?, '{}')",
            ].join(" "),
          )
          .run(
            semanticKeySha256,
            physicalOperationKeySha256,
            sha256("orphan-capability"),
            sha256("orphan-context"),
            sha256("orphan-record"),
          );
      } else {
        database
          .prepare(
            [
              "INSERT INTO broker_results",
              "(semantic_key_sha256, physical_operation_key_sha256, task_sha256,",
              " result_sha256, result_json)",
              "VALUES (?, ?, ?, ?, '{}')",
            ].join(" "),
          )
          .run(
            semanticKeySha256,
            physicalOperationKeySha256,
            sha256("orphan-task"),
            sha256("orphan-result"),
          );
      }
      database.close();

      await expect(reopenJournalForTest(root, task)).rejects.toMatchObject({
        code: "BROKER_JOURNAL_REFERENTIAL_INTEGRITY",
      });
    },
  );
});
