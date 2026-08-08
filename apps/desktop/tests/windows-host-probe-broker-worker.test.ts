import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  openJournal: vi.fn(),
  openMailbox: vi.fn(),
  openNativeAuthoritySession: vi.fn(),
}));

vi.mock("../scripts/windows-host-falsifier/broker/journal.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/windows-host-falsifier/broker/journal.mjs")
  >()),
  openProbeBrokerJournal: dependencyMocks.openJournal,
}));

vi.mock("../scripts/windows-host-falsifier/broker/mailbox.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/windows-host-falsifier/broker/mailbox.mjs")
  >()),
  openProbeBrokerMailbox: dependencyMocks.openMailbox,
}));

vi.mock(
  "../scripts/windows-host-falsifier/broker/native-authority.mjs",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../scripts/windows-host-falsifier/broker/native-authority.mjs")
    >()),
    openProbeBrokerNativeAuthoritySession: dependencyMocks.openNativeAuthoritySession,
  }),
);

import {
  acquireProbeBrokerExecutionAuthorityLease,
  markProbeBrokerExecutionAuthorityEffectStarted,
  markProbeBrokerExecutionAuthorityResultRetained,
  releaseProbeBrokerExecutionAuthorityLease,
} from "../scripts/windows-host-falsifier/broker/execution-authority.mjs";
import { openProbeBrokerJournalStorageForTest } from "../scripts/windows-host-falsifier/broker/journal.mjs";
import {
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
  type ProbeBrokerMailboxObservation,
  type ProbePreparedBrokerEnrollment,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { initializeProbeBrokerMailboxStore } from "../scripts/windows-host-falsifier/broker/mailbox.mjs";
import {
  createProbeBrokerPreparedOperationAuthority,
  type ProbeBrokerPreparedOperationAuthority,
} from "../scripts/windows-host-falsifier/broker/native-authority.mjs";
import {
  acceptProbeBrokerTask,
  createProbeBrokerTask,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  validateProbeBrokerResult,
  type ProbeAcceptedBrokerTaskContext,
  type ProbeBrokerAcceptanceCapability,
  type ProbeBrokerExecutionMapping,
  type ProbeBrokerTask,
} from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  PROBE_BROKER_WORKER_DRIVER_TERMINAL_KIND,
  PROBE_BROKER_WORKER_MANUAL_INTERVENTION_KIND,
  createProbeBrokerWorker,
  type ProbeBrokerWorkerDriver,
  type ProbeBrokerWorkerDriverTerminal,
} from "../scripts/windows-host-falsifier/broker/worker.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import { hashProbeCanonicalJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { deriveProbeRuntimeScenarioOperationId } from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { PROBE_RUN_PLAN } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";
import { openEvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import type { NativeBuild } from "../scripts/windows-host-falsifier/native-client.mjs";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});

function fixture(
  roots: {
    readonly mailboxRoot?: string;
    readonly journalRoot?: string;
  } = {},
) {
  const mailboxRoot = roots.mailboxRoot ?? "E:\\Broker\\worker\\primary-mailbox";
  const journalRoot = roots.journalRoot ?? "E:\\Broker\\worker\\primary-journal";
  const mailboxVolumeIdentity = sha256(`worker-volume:${mailboxRoot.slice(0, 2).toUpperCase()}`);
  const journalVolumeIdentity = sha256(`worker-volume:${journalRoot.slice(0, 2).toUpperCase()}`);
  const processSidSha256 = sha256("worker-primary-sid");
  const enrollment = createProbeBrokerEnrollment({
    environmentId: "win11-current",
    brokerRole: "primary-standard-user",
    brokerInstanceId: "worker-primary-broker",
    mailboxRoot,
    mailboxAclSha256: sha256("worker-mailbox-acl"),
    journalRoot,
    journalRootAclSha256: sha256("worker-journal-root-acl"),
    journalDatabaseAclSha256: sha256("worker-journal-database-acl"),
    processSidSha256,
    peerAuthoritySha256: null,
  });
  const preparedBrokerEnrollment = createProbePreparedBrokerEnrollment(enrollment, {
    schemaVersion: 1,
    kind: "windows-host-probe-broker-mailbox-observation",
    brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
    environmentId: enrollment.environmentId,
    brokerRole: enrollment.brokerRole,
    brokerInstanceId: enrollment.brokerInstanceId,
    mailboxRoot,
    mailboxSecurityProfile: enrollment.mailboxSecurityProfile,
    mailboxAclSha256: enrollment.mailboxAclSha256,
    mailboxOwnerSidSha256: processSidSha256,
    processSidSha256,
    peerAuthoritySha256: null,
    mailboxRootObjectIdentitySha256: sha256(`worker-mailbox-object:${mailboxRoot}`),
    mailboxVolumeIdSha256: mailboxVolumeIdentity,
    mailboxTransportIdentitySha256: sha256(`worker-mailbox-transport:${mailboxRoot}`),
    mailboxFileSystem: "NTFS",
    mailboxDriveType: "fixed",
    mailboxLocalAbsolute: true,
    mailboxNetworkPath: false,
    mailboxReparsePoint: false,
    journalRoot,
    journalSecurityProfile: enrollment.journalSecurityProfile,
    journalRootPathSha256: sha256(`worker-journal-root-path:${journalRoot}`),
    journalRootObjectIdentitySha256: sha256(`worker-journal-root-object:${journalRoot}`),
    journalVolumeIdSha256: journalVolumeIdentity,
    journalRootOwnerSidSha256: processSidSha256,
    journalRootAclSha256: enrollment.journalRootAclSha256,
    journalDatabasePathSha256: sha256(`worker-journal-database-path:${journalRoot}`),
    journalDatabaseObjectIdentitySha256: sha256(`worker-journal-database-object:${journalRoot}`),
    journalDatabaseOwnerSidSha256: processSidSha256,
    journalDatabaseAclSha256: enrollment.journalDatabaseAclSha256,
    journalTransportIdentitySha256: sha256(`worker-journal-transport:${journalRoot}`),
    journalFileSystem: "NTFS",
    journalDriveType: "fixed",
    journalLocalAbsolute: true,
    journalNetworkPath: false,
    journalReparsePoint: false,
    bootIdSha256: sha256("worker-boot"),
    runnerSessionIdSha256: sha256("worker-runner-session"),
    nativeHelperSha256: sha256("worker-native-helper"),
    nativeObservationSha256: sha256(`worker-native-observation:${mailboxRoot}:${journalRoot}`),
  });
  const requestBytes = Buffer.from("worker signed driver request", "utf8");
  const definition = getProbeScenarioDefinition("F-01", "f01-ordinary-absolute-path");
  const action = definition.actions.find(({ actionId }) => actionId === "prepare-home-topology")!;
  const execution = getProbeActionMapping({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action,
  }) as ProbeBrokerExecutionMapping;
  const campaignRunId = "worker-campaign-run";
  const executionRunId = "worker-execution-run";
  const attemptId = "worker-attempt-a";
  const workItem = PROBE_RUN_PLAN.work.find(
    (candidate) =>
      candidate.environmentId === "win11-current" &&
      candidate.pathProfileId === "ascii" &&
      candidate.rowId === definition.rowId &&
      candidate.variantId === definition.variantId,
  )!;
  const operationId = deriveProbeRuntimeScenarioOperationId(
    { campaignRunId, attemptId, workId: workItem.workId },
    action.actionId,
  );
  const expectedActor = {
    role: "primary-standard-user" as const,
    identitySource: "actors.primaryStandardUserSidSha256" as const,
    identitySha256: processSidSha256,
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
    actionId: action.actionId,
    operationId,
    action,
    execution,
    expectedActor,
  });
  const requestSha256 = sha256(requestBytes);
  const task = createProbeBrokerTask(
    {
      taskId: "worker-task-a",
      controllerIdentitySha256: sha256("worker-controller-identity"),
      controllerPublicKeySha256: sha256(controllerPublicKeyBytes),
      candidateSha256: sha256("worker-candidate"),
      runAuthorizationClaimReceiptSha256: sha256("worker-run-authorization"),
      coordinate: {
        campaignRunId,
        executionRunId,
        attemptId,
        workId: workItem.workId,
        environmentId: "win11-current",
        pathProfileId: "ascii",
        rowId: definition.rowId as `F-${string}`,
        variantId: definition.variantId,
        repetition: null,
      },
      runtimeActionIntentSha256,
      action: {
        scenarioPlanSha256: definition.planSha256,
        producerActionId: action.actionId,
        operationId,
        sequence: action.sequence,
      },
      execution,
      actorSelectorInput: null,
      expectedActor,
      brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
      brokerInstanceId: enrollment.brokerInstanceId,
      brokerRole: enrollment.brokerRole,
      mailboxAclSha256: enrollment.mailboxAclSha256,
      processSidSha256,
      bootIdSha256: preparedBrokerEnrollment.bootIdSha256,
      runnerSessionIdSha256: preparedBrokerEnrollment.runnerSessionIdSha256,
      driverRequest: {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-driver-request",
        driverId: execution.driverId,
        requestArtifact: {
          blobPath: `blobs/sha256/${requestSha256}`,
          bytes: requestBytes.byteLength,
          sha256: requestSha256,
        },
      },
      recoveryClass: "inspect-and-reconcile",
      issuedAt: "2098-12-31T23:55:00.000Z",
      deadline: "2099-01-01T00:00:00.000Z",
      nonceBase64: Buffer.alloc(32, 11).toString("base64"),
    },
    (digest) => sign(null, digest, controllerKeys.privateKey),
  );
  const preparedOperationAuthority = createProbeBrokerPreparedOperationAuthority({
    preparedRunGenerationSha256: sha256("worker-prepared-generation"),
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
    driverId: task.execution.driverId,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    preparedBrokerEnrollmentSha256: preparedBrokerEnrollment.preparedBrokerEnrollmentSha256,
    brokerInstanceId: task.brokerInstanceId,
    brokerRole: task.brokerRole,
  });
  return {
    journalRoot,
    preparedBrokerEnrollment,
    preparedOperationAuthority,
    requestBytes,
    task,
  };
}

function reference(label: string) {
  const bytes = Buffer.from(`worker-artifact:${label}`, "utf8");
  const digest = sha256(bytes);
  return {
    bytes,
    reference: {
      blobPath: `blobs/sha256/${digest}` as const,
      bytes: bytes.byteLength,
      sha256: digest,
    },
  };
}

function terminal(label = "success"): ProbeBrokerWorkerDriverTerminal {
  const driverResult = reference(`driver:${label}`);
  const proof = reference(`proof:${label}`);
  const observer = reference(`observer:${label}`);
  return {
    schemaVersion: 1,
    kind: PROBE_BROKER_WORKER_DRIVER_TERMINAL_KIND,
    effectSha256: sha256(`effect:${label}`),
    outcome: "SUCCEEDED",
    driverResultArtifact: driverResult.reference,
    proofArtifacts: [proof.reference],
    observerTranscripts: [
      {
        ...observer.reference,
        transcriptSha256: sha256(`transcript:${label}`),
      },
    ],
    pausedSessionReceipt: proof.reference,
    artifacts: [driverResult, proof, observer],
  };
}

type DurableState = {
  currentState: "absent" | "accepted" | "effect-started" | "effect-committed" | "result-retained";
  task: ProbeBrokerTask | null;
  originalCapability: ProbeBrokerAcceptanceCapability | null;
  effectSha256: string | null;
  result: ReturnType<typeof validateProbeBrokerResult> | null;
};

function recoveryFor(state: DurableState, context: ProbeAcceptedBrokerTaskContext) {
  const currentState = state.currentState === "absent" ? "accepted" : state.currentState;
  const orchestrationDirective =
    currentState === "accepted"
      ? "execute"
      : currentState === "result-retained"
        ? "replay-retained-result"
        : context.task.recoveryClass === "inspect-and-reconcile"
          ? "reconcile"
          : "manual-intervention";
  return {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-broker-journal-recovery" as const,
    authoritySha256: sha256("worker-journal-authority"),
    semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(context.task),
    physicalOperationKeySha256: deriveProbeBrokerTaskPhysicalOperationKeySha256(context.task),
    taskSha256: context.task.taskSha256,
    currentState,
    recoveryClass: context.task.recoveryClass,
    protocolRecoveryDirective: context.recoveryDirective,
    orchestrationDirective,
    transitionRecordSha256: sha256(`transition:${currentState}`),
    effectSha256: state.effectSha256,
    resultSha256: state.result?.resultSha256 ?? null,
    recoverySha256: sha256(`recovery:${currentState}`),
  };
}

function controllerAcceptanceInput(state: DurableState) {
  const capability = state.originalCapability!;
  const result = state.result!;
  return {
    coordinate: capability.coordinate,
    producerActionId: capability.producerActionId,
    brokerTaskSha256: capability.brokerTaskSha256,
    brokerTaskNonceSha256: capability.brokerTaskNonceSha256,
    brokerResultSha256: result.resultSha256,
    brokerEnrollmentSha256: capability.brokerEnrollmentSha256,
    brokerInstanceId: capability.brokerInstanceId,
    brokerRole: capability.brokerRole,
    expectedActor: capability.expectedActor,
    mailboxAclSha256: capability.mailboxAclSha256,
    processSidSha256: capability.processSidSha256,
    bootIdSha256: capability.bootIdSha256,
    runnerSessionIdSha256: capability.runnerSessionIdSha256,
    replayJournalDisposition: capability.replayJournalDisposition,
    replayJournalEntrySha256: capability.replayJournalEntrySha256,
  };
}

function executionSnapshot(
  authority: ProbeBrokerPreparedOperationAuthority,
  binding: ProbePreparedBrokerEnrollment,
) {
  return {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-broker-execution-authority" as const,
    preparedRunGenerationSha256: authority.preparedRunGenerationSha256,
    controllerIdentitySha256: authority.controllerIdentitySha256,
    controllerPublicKeySha256: authority.controllerPublicKeySha256,
    candidateSha256: authority.candidateSha256,
    runAuthorizationClaimReceiptSha256: authority.runAuthorizationClaimReceiptSha256,
    coordinate: authority.coordinate,
    semanticKeySha256: authority.semanticKeySha256,
    physicalOperationKeySha256: authority.physicalOperationKeySha256,
    runtimeActionIntentSha256: authority.runtimeActionIntentSha256,
    operationId: authority.operationId,
    producerActionId: authority.producerActionId,
    driverId: authority.driverId,
    brokerEnrollmentSha256: binding.brokerEnrollmentSha256,
    preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
    brokerInstanceId: binding.brokerInstanceId,
    brokerRole: binding.brokerRole,
    mailboxRootObjectIdentitySha256: binding.mailboxRootObjectIdentitySha256,
    mailboxVolumeIdSha256: binding.mailboxVolumeIdSha256,
    mailboxTransportIdentitySha256: binding.mailboxTransportIdentitySha256,
    mailboxAclSha256: binding.mailboxAclSha256,
    mailboxOwnerSidSha256: binding.mailboxOwnerSidSha256,
    journalRoot: binding.journalRoot,
    journalSecurityProfile: binding.journalSecurityProfile,
    journalRootPathSha256: binding.journalRootPathSha256,
    journalRootObjectIdentitySha256: binding.journalRootObjectIdentitySha256,
    journalVolumeIdSha256: binding.journalVolumeIdSha256,
    journalRootOwnerSidSha256: binding.journalRootOwnerSidSha256,
    journalRootAclSha256: binding.journalRootAclSha256,
    journalDatabasePathSha256: binding.journalDatabasePathSha256,
    journalDatabaseObjectIdentitySha256: binding.journalDatabaseObjectIdentitySha256,
    journalDatabaseOwnerSidSha256: binding.journalDatabaseOwnerSidSha256,
    journalDatabaseAclSha256: binding.journalDatabaseAclSha256,
    journalTransportIdentitySha256: binding.journalTransportIdentitySha256,
    processSidSha256: binding.processSidSha256,
    bootIdSha256: binding.bootIdSha256,
    runnerSessionIdSha256: binding.runnerSessionIdSha256,
    nativeObservationSha256: binding.nativeObservationSha256,
    peerAuthoritySha256: binding.peerAuthoritySha256,
  };
}

function observationFromBinding(
  binding: ProbePreparedBrokerEnrollment,
): ProbeBrokerMailboxObservation {
  const { preparedBrokerEnrollmentSha256: _preparedBrokerEnrollmentSha256, ...preparedFields } =
    binding;
  return {
    ...preparedFields,
    kind: "windows-host-probe-broker-mailbox-observation",
  };
}

function createHarness(
  options: {
    readonly afterEffectCommitted?: () => Promise<void>;
    readonly afterEffectAuthorized?: () => Promise<void>;
    readonly afterResultRetained?: () => Promise<void>;
    readonly beforeEffectAuthorized?: () => Promise<void>;
    readonly beforeNativeRelease?: () => Promise<void>;
    readonly stageResultArtifacts?: (input: unknown) => Promise<void>;
    readonly publishRetainedResult?: (input: unknown) => Promise<void>;
    readonly revalidateExecutionAuthority?: (
      snapshot: ReturnType<typeof executionSnapshot>,
    ) => ReturnType<typeof executionSnapshot>;
    readonly task?: ProbeBrokerTask;
  } = {},
) {
  const values = fixture();
  const deliveredTask = options.task ?? values.task;
  const log: string[] = [];
  const state: DurableState = {
    currentState: "absent",
    task: null,
    originalCapability: null,
    effectSha256: null,
    result: null,
  };
  const sessions: { readonly release: ReturnType<typeof vi.fn> }[] = [];
  const journals: { readonly close: ReturnType<typeof vi.fn> }[] = [];
  const stagedInputs: unknown[] = [];
  const publishedInputs: any[] = [];
  const refusalInputs: any[] = [];
  const driverTerminal = terminal();
  const driver: ProbeBrokerWorkerDriver = {
    driverId: values.task.execution.driverId,
    requestSchemaSha256: sha256("worker-driver-request-schema"),
    recoveryClass: "inspect-and-reconcile",
    validateRequest: vi.fn(async (bytes: Buffer) => {
      log.push("driver-validate");
      expect(bytes).toEqual(values.requestBytes);
      return Object.freeze({ operation: "prepared" });
    }),
    execute: vi.fn(async () => {
      log.push("driver-execute");
      return driverTerminal;
    }),
    reconcile: vi.fn(async () => {
      log.push("driver-reconcile");
      return driverTerminal;
    }),
  };

  dependencyMocks.openNativeAuthoritySession.mockImplementation(async (openOptions) => {
    log.push("native-open");
    if (openOptions.openContextChannel !== undefined) {
      await openOptions.openContextChannel();
    }
    const snapshot = executionSnapshot(
      values.preparedOperationAuthority,
      values.preparedBrokerEnrollment,
    );
    const executionAuthorityLease = await acquireProbeBrokerExecutionAuthorityLease({
      acquire: () => snapshot,
      revalidate: () => options.revalidateExecutionAuthority?.(snapshot) ?? snapshot,
      release: async () => undefined,
    });
    const release = vi.fn(async () => {
      log.push("native-release");
      await options.beforeNativeRelease?.();
      await releaseProbeBrokerExecutionAuthorityLease(executionAuthorityLease);
    });
    sessions.push({ release });
    return {
      preparedOperationAuthority: values.preparedOperationAuthority,
      preparedMailboxBinding: values.preparedBrokerEnrollment,
      executionAuthorityLease,
      assertMailboxAuthority: vi.fn(),
      release,
    };
  });

  dependencyMocks.openMailbox.mockImplementation(() => {
    log.push("mailbox-open");
    return {
      readTask: vi.fn(async (physicalOperationKeySha256: string) => {
        log.push("read-task");
        expect(physicalOperationKeySha256).toBe(
          values.preparedOperationAuthority.physicalOperationKeySha256,
        );
        return {
          task: deliveredTask,
          driverRequestBytes: values.requestBytes,
        };
      }),
      stageResultArtifacts: vi.fn(async (input: unknown) => {
        log.push("stage-artifacts");
        stagedInputs.push(input);
        await options.stageResultArtifacts?.(input);
      }),
      publishRetainedResult: vi.fn(async (input: any) => {
        log.push("publish-result");
        publishedInputs.push(input);
        await options.publishRetainedResult?.(input);
        return { resultEnvelopeSha256: sha256("worker-result-envelope") };
      }),
      publishRefusal: vi.fn(async (input: any) => {
        log.push("publish-refusal");
        refusalInputs.push(input);
        return { refusalEnvelopeSha256: sha256("worker-refusal-envelope") };
      }),
    };
  });

  dependencyMocks.openJournal.mockImplementation(async ({ executionAuthorityLease }) => {
    log.push("journal-open");
    const close = vi.fn(async () => {
      log.push("journal-close");
    });
    journals.push({ close });
    return {
      acceptTask: vi.fn(async (task: ProbeBrokerTask, acceptanceOptions: any) => {
        log.push("accept-task");
        const context = await acceptProbeBrokerTask(task, {
          controllerPublicKeyBytes: acceptanceOptions.controllerPublicKeyBytes,
          expectedControllerIdentitySha256: task.controllerIdentitySha256,
          executionAuthorityLease: acceptanceOptions.executionAuthorityLease,
          validateDriverRequest: acceptanceOptions.validateDriverRequest,
          verificationInstant: acceptanceOptions.verificationInstant,
          replayGuard: {
            consume(binding) {
              if (state.task === null) {
                state.task = task;
                state.currentState = "accepted";
                return {
                  disposition: "fresh" as const,
                  semanticKeySha256: binding.semanticKeySha256,
                  physicalOperationKeySha256: binding.physicalOperationKeySha256,
                  taskSha256: task.taskSha256,
                  replayJournalEntrySha256: sha256("worker-replay-entry"),
                };
              }
              return {
                disposition: "retained" as const,
                semanticKeySha256: binding.semanticKeySha256,
                physicalOperationKeySha256: binding.physicalOperationKeySha256,
                taskSha256: task.taskSha256,
                replayJournalEntrySha256: sha256("worker-replay-entry"),
              };
            },
          },
        });
        if (context.capability.replayJournalDisposition === "accepted") {
          state.originalCapability = context.capability;
        }
        if (state.currentState !== "accepted") {
          markProbeBrokerExecutionAuthorityEffectStarted(executionAuthorityLease);
        }
        if (state.currentState === "result-retained") {
          markProbeBrokerExecutionAuthorityResultRetained(executionAuthorityLease);
        }
        return context;
      }),
      recover: vi.fn(async (context: ProbeAcceptedBrokerTaskContext) => {
        log.push("recover");
        return recoveryFor(state, context);
      }),
      readTaskByDigest: vi.fn(async (taskSha256: string) =>
        state.task?.taskSha256 === taskSha256
          ? { currentState: state.currentState, task: state.task }
          : null,
      ),
      authorizeEffect: vi.fn(async (context: ProbeAcceptedBrokerTaskContext) => {
        log.push("authorize-effect");
        if (state.currentState === "accepted") {
          await options.beforeEffectAuthorized?.();
          state.currentState = "effect-started";
          markProbeBrokerExecutionAuthorityEffectStarted(executionAuthorityLease);
          await options.afterEffectAuthorized?.();
          return { authorized: true, record: {} };
        }
        return {
          authorized: false,
          record: {},
          recovery: recoveryFor(state, context),
        };
      }),
      recordEffectCommitted: vi.fn(async ({ effectSha256 }: any) => {
        log.push("commit-effect");
        if (state.effectSha256 !== null && state.effectSha256 !== effectSha256) {
          throw new Error("effect commitment changed");
        }
        state.effectSha256 = effectSha256;
        if (state.currentState !== "result-retained") {
          state.currentState = "effect-committed";
        }
        await options.afterEffectCommitted?.();
        return { created: true, record: {} };
      }),
      recordResultRetained: vi.fn(async ({ result }: any) => {
        log.push("retain-result");
        const validated = validateProbeBrokerResult(result);
        if (state.result !== null && state.result.resultSha256 !== validated.resultSha256) {
          throw new Error("retained result changed");
        }
        state.result = validated;
        state.currentState = "result-retained";
        markProbeBrokerExecutionAuthorityResultRetained(executionAuthorityLease);
        await options.afterResultRetained?.();
        return { created: true, record: {} };
      }),
      readRetainedCompletion: vi.fn(async () => {
        log.push("read-completion");
        if (state.result === null || state.originalCapability === null) return null;
        return {
          result: state.result,
          controllerAcceptanceInput: controllerAcceptanceInput(state),
        };
      }),
      close,
    };
  });

  function worker(
    workerOptions: {
      readonly driverRegistry?: readonly ProbeBrokerWorkerDriver[];
      readonly openNativeBrokerContextChannel?: () => Promise<never>;
    } = {},
  ) {
    return createProbeBrokerWorker({
      nativeBuild: Object.freeze({}) as NativeBuild,
      preparedBrokerEnrollment: values.preparedBrokerEnrollment,
      preparedOperationAuthority: values.preparedOperationAuthority,
      expectedPreparedOperationAuthoritySha256:
        values.preparedOperationAuthority.preparedOperationAuthoritySha256,
      mailboxStore: Object.freeze({
        root: values.preparedBrokerEnrollment.mailboxRoot,
      }) as never,
      journalRoot: values.journalRoot,
      controllerPublicKeyBytes,
      driverRegistry: workerOptions.driverRegistry ?? [driver],
      now: () => new Date("2098-12-31T23:59:59.000Z"),
      ...(workerOptions.openNativeBrokerContextChannel === undefined
        ? {}
        : {
            openNativeBrokerContextChannel: workerOptions.openNativeBrokerContextChannel,
          }),
    });
  }

  return {
    driver,
    driverTerminal,
    journals,
    log,
    publishedInputs,
    refusalInputs,
    sessions,
    stagedInputs,
    state,
    values,
    worker,
  };
}

beforeEach(() => {
  dependencyMocks.openJournal.mockReset();
  dependencyMocks.openMailbox.mockReset();
  dependencyMocks.openNativeAuthoritySession.mockReset();
});

describe("Windows host probe broker worker", () => {
  it("propagates process-exit authority from native session startup cleanup", async () => {
    const harness = createHarness();
    const nativeCleanupFailure = Object.assign(new Error("native startup cleanup failed"), {
      code: "BROKER_NATIVE_AUTHORITY_RELEASE",
      requiresProcessExit: true as const,
    });
    dependencyMocks.openNativeAuthoritySession.mockRejectedValue(nativeCleanupFailure);

    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
      cause: nativeCleanupFailure,
    });
    expect(dependencyMocks.openMailbox).not.toHaveBeenCalled();
    expect(dependencyMocks.openJournal).not.toHaveBeenCalled();
  });

  it("runs the exact prepared task through durable terminal ordering and releases last", async () => {
    const harness = createHarness();
    const nativeOpener = vi.fn(async (...args: unknown[]) => {
      expect(args).toEqual([]);
      return {} as never;
    });

    const result = await harness
      .worker({
        openNativeBrokerContextChannel: nativeOpener,
      })
      .run();

    expect(result).toMatchObject({
      disposition: "published-result",
      physicalOperationKeySha256:
        harness.values.preparedOperationAuthority.physicalOperationKeySha256,
      taskSha256: harness.values.task.taskSha256,
    });
    expect(nativeOpener).toHaveBeenCalledOnce();
    expect(harness.driver.validateRequest).toHaveBeenCalledOnce();
    expect(harness.driver.execute).toHaveBeenCalledOnce();
    expect(harness.driver.reconcile).not.toHaveBeenCalled();
    expect(harness.log).toEqual([
      "native-open",
      "mailbox-open",
      "journal-open",
      "read-task",
      "accept-task",
      "driver-validate",
      "recover",
      "authorize-effect",
      "driver-execute",
      "commit-effect",
      "stage-artifacts",
      "retain-result",
      "read-completion",
      "publish-result",
      "journal-close",
      "native-release",
    ]);
    expect(harness.publishedInputs[0].controllerAcceptanceInput).toMatchObject({
      replayJournalDisposition: "accepted",
      brokerTaskSha256: harness.values.task.taskSha256,
    });
  });

  it("restarts through the real mailbox and journal state machines without another effect", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "enduragent-broker-worker-integration-")),
    );
    try {
      const physicalMailboxRoot = join(root, "mailbox");
      const physicalJournalRoot = join(root, "journal");
      const values =
        process.platform === "win32"
          ? fixture({
              mailboxRoot: `${physicalMailboxRoot[0]?.toUpperCase()}${physicalMailboxRoot.slice(1)}`,
              journalRoot: `${physicalJournalRoot[0]?.toUpperCase()}${physicalJournalRoot.slice(1)}`,
            })
          : fixture();
      await mkdir(physicalMailboxRoot, { mode: 0o700 });
      await mkdir(physicalJournalRoot, { mode: 0o700 });
      const physicalStore = await openEvidenceStore({ root: physicalMailboxRoot });
      const mailboxStore = Object.freeze({
        ...physicalStore,
        root: values.preparedBrokerEnrollment.mailboxRoot,
      });
      await initializeProbeBrokerMailboxStore({ store: mailboxStore });
      const mailboxModule = await vi.importActual<
        typeof import("../scripts/windows-host-falsifier/broker/mailbox.mjs")
      >("../scripts/windows-host-falsifier/broker/mailbox.mjs");
      const journalModule = await vi.importActual<
        typeof import("../scripts/windows-host-falsifier/broker/journal.mjs")
      >("../scripts/windows-host-falsifier/broker/journal.mjs");
      const liveObservation = observationFromBinding(values.preparedBrokerEnrollment);
      const controllerMailbox = mailboxModule.openProbeBrokerMailbox({
        store: mailboxStore,
        binding: values.preparedBrokerEnrollment,
        principal: "controller",
        assertMailboxAuthority: async () => liveObservation,
      });
      await controllerMailbox.publishTask({
        task: values.task,
        driverRequestBytes: values.requestBytes,
      });

      const snapshot = {
        ...executionSnapshot(values.preparedOperationAuthority, values.preparedBrokerEnrollment),
        journalRoot: physicalJournalRoot,
      };
      const releases: ReturnType<typeof vi.fn>[] = [];
      dependencyMocks.openMailbox.mockImplementation((options) =>
        mailboxModule.openProbeBrokerMailbox(options),
      );
      dependencyMocks.openJournal.mockImplementation(
        async ({ preparedBrokerEnrollment, executionAuthorityLease }) =>
          process.platform === "win32"
            ? journalModule.openProbeBrokerJournal({
                root: physicalJournalRoot,
                preparedBrokerEnrollment,
                executionAuthorityLease,
              })
            : openProbeBrokerJournalStorageForTest({
                root: physicalJournalRoot,
                executionAuthorityLease,
              }),
      );
      dependencyMocks.openNativeAuthoritySession.mockImplementation(async () => {
        const executionAuthorityLease = await acquireProbeBrokerExecutionAuthorityLease({
          acquire: async () => snapshot,
          revalidate: async () => snapshot,
          release: async () => undefined,
        });
        const release = vi.fn(async () =>
          releaseProbeBrokerExecutionAuthorityLease(executionAuthorityLease),
        );
        releases.push(release);
        return {
          preparedOperationAuthority: values.preparedOperationAuthority,
          preparedMailboxBinding: values.preparedBrokerEnrollment,
          executionAuthorityLease,
          assertMailboxAuthority: vi.fn(async () => liveObservation),
          release,
        };
      });
      const driverTerminal = terminal("real-storage-restart");
      const driver: ProbeBrokerWorkerDriver = {
        driverId: values.task.execution.driverId,
        requestSchemaSha256: sha256("real-storage-driver-schema"),
        recoveryClass: "inspect-and-reconcile",
        validateRequest: vi
          .fn()
          .mockResolvedValueOnce(Object.freeze({ operation: "prepared" }))
          .mockRejectedValue(new Error("retained replay must not reparse")),
        execute: vi.fn(async () => driverTerminal),
        reconcile: vi.fn(async () => driverTerminal),
      };
      const createWorker = (now = "2098-12-31T23:59:59.000Z") =>
        createProbeBrokerWorker({
          nativeBuild: Object.freeze({}) as NativeBuild,
          preparedBrokerEnrollment: values.preparedBrokerEnrollment,
          preparedOperationAuthority: values.preparedOperationAuthority,
          expectedPreparedOperationAuthoritySha256:
            values.preparedOperationAuthority.preparedOperationAuthoritySha256,
          mailboxStore,
          journalRoot: values.journalRoot,
          controllerPublicKeyBytes,
          driverRegistry: [driver],
          now: () => new Date(now),
        });

      await expect(createWorker().run()).resolves.toMatchObject({
        disposition: "published-result",
      });
      await expect(createWorker("2100-01-01T00:00:00.000Z").run()).resolves.toMatchObject({
        disposition: "replayed-retained-result",
      });
      await expect(controllerMailbox.readResult(values.task)).resolves.toMatchObject({
        result: { taskSha256: values.task.taskSha256 },
        controllerAcceptanceInput: {
          replayJournalDisposition: "accepted",
          brokerTaskSha256: values.task.taskSha256,
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            reference: driverTerminal.driverResultArtifact,
          }),
        ]),
      });
      expect(driver.execute).toHaveBeenCalledOnce();
      expect(driver.validateRequest).toHaveBeenCalledOnce();
      expect(driver.reconcile).not.toHaveBeenCalled();
      expect(releases).toHaveLength(2);
      for (const release of releases) expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never invokes driver parsing for an invalid task signature", async () => {
    const values = fixture();
    const invalidSignatureTask = {
      ...values.task,
      signatureBase64: Buffer.alloc(64, 99).toString("base64"),
    } as ProbeBrokerTask;
    const harness = createHarness({ task: invalidSignatureTask });
    const mismatchedDriver = {
      ...harness.driver,
      recoveryClass: "read-only-replay" as const,
    };

    await expect(
      harness.worker({ driverRegistry: [mismatchedDriver] }).run(),
    ).resolves.toMatchObject({
      disposition: "published-refusal",
      refusalCode: "MALFORMED_TASK",
    });
    expect(harness.driver.validateRequest).not.toHaveBeenCalled();
    expect(harness.driver.execute).not.toHaveBeenCalled();
    expect(harness.refusalInputs).toHaveLength(1);
    expect(harness.log.slice(-2)).toEqual(["journal-close", "native-release"]);
  });

  it("reconciles after a crash between effect commitment and result retention without re-executing", async () => {
    let failStage = true;
    const harness = createHarness({
      stageResultArtifacts: async () => {
        if (failStage) {
          failStage = false;
          throw new Error("simulated crash after effect commitment");
        }
      },
    });

    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
      cause: expect.objectContaining({
        message: "simulated crash after effect commitment",
      }),
    });
    expect(harness.state.currentState).toBe("effect-committed");
    expect(harness.sessions[0].release).not.toHaveBeenCalled();
    expect(harness.refusalInputs).toHaveLength(0);

    await expect(harness.worker().run()).resolves.toMatchObject({
      disposition: "published-result",
    });
    expect(harness.driver.execute).toHaveBeenCalledOnce();
    expect(harness.driver.reconcile).toHaveBeenCalledOnce();
    expect(harness.state.currentState).toBe("result-retained");
    expect(harness.sessions[1].release).toHaveBeenCalledOnce();
  });

  it("snapshots a driver terminal before yielding to durable effect commitment", async () => {
    let mutateTerminal = async () => undefined;
    const harness = createHarness({
      afterEffectCommitted: async () => mutateTerminal(),
    });
    const driverArtifact = harness.driverTerminal.artifacts.find(
      ({ reference }) => reference.sha256 === harness.driverTerminal.driverResultArtifact.sha256,
    )!;
    const originalBytes = Buffer.from(driverArtifact.bytes);
    mutateTerminal = async () => {
      Object.assign(harness.driverTerminal, {
        effectSha256: sha256("mutated-after-effect-commit"),
      });
      driverArtifact.bytes.fill(0);
    };

    await expect(harness.worker().run()).resolves.toMatchObject({
      disposition: "published-result",
    });
    expect(harness.state.effectSha256).toBe(sha256("effect:success"));
    const stagedDriverArtifact = (harness.stagedInputs[0] as any).artifacts.find(
      ({ reference }: any) =>
        reference.sha256 === harness.driverTerminal.driverResultArtifact.sha256,
    );
    expect(stagedDriverArtifact.bytes).toEqual(originalBytes);
  });

  it("replays the stable retained completion after a crash before envelope publication", async () => {
    let failPublish = true;
    const harness = createHarness({
      publishRetainedResult: async () => {
        if (failPublish) {
          failPublish = false;
          throw new Error("simulated crash before result envelope publication");
        }
      },
    });

    await expect(harness.worker().run()).rejects.toThrow(
      /simulated crash before result envelope publication/u,
    );
    expect(harness.state.currentState).toBe("result-retained");
    expect(harness.sessions[0].release).toHaveBeenCalledOnce();

    await expect(harness.worker().run()).resolves.toMatchObject({
      disposition: "replayed-retained-result",
    });
    expect(harness.driver.execute).toHaveBeenCalledOnce();
    expect(harness.driver.reconcile).not.toHaveBeenCalled();
    expect(harness.stagedInputs).toHaveLength(1);
    expect(harness.publishedInputs).toHaveLength(2);
    expect(
      harness.publishedInputs.map(
        ({ controllerAcceptanceInput }) => controllerAcceptanceInput.replayJournalDisposition,
      ),
    ).toEqual(["accepted", "accepted"]);
  });

  it("requires process exit when native authority release persistently fails", async () => {
    const harness = createHarness({
      beforeNativeRelease: async () => {
        throw new Error("persistent native release failure");
      },
    });

    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
    });
    expect(harness.state.currentState).toBe("result-retained");
    expect(harness.sessions[0].release).toHaveBeenCalledTimes(2);
    expect(harness.driver.execute).toHaveBeenCalledOnce();
    expect(harness.publishedInputs).toHaveLength(1);
  });

  it("finishes cleanup without exit authority when a native release retry succeeds", async () => {
    let releaseAttempts = 0;
    const harness = createHarness({
      beforeNativeRelease: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("transient native release failure");
      },
    });

    await expect(harness.worker().run()).rejects.toThrow(/transient native release failure/u);
    expect(harness.sessions[0].release).toHaveBeenCalledTimes(2);
    expect(harness.state.currentState).toBe("result-retained");
    await expect(harness.worker().run()).resolves.toMatchObject({
      disposition: "replayed-retained-result",
    });
    expect(harness.driver.execute).toHaveBeenCalledOnce();
    expect(harness.sessions[1].release).toHaveBeenCalledOnce();
  });

  it("keeps incomplete authority live when reconciliation requires manual intervention", async () => {
    const harness = createHarness();
    harness.driver.execute = vi.fn(async () => {
      throw new Error("physical executor exited after effect start");
    });

    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
      cause: expect.objectContaining({
        message: "physical executor exited after effect start",
      }),
    });
    expect(harness.state.currentState).toBe("effect-started");
    expect(harness.sessions[0].release).not.toHaveBeenCalled();
    harness.driver.reconcile = vi.fn(async () => ({
      schemaVersion: 1 as const,
      kind: PROBE_BROKER_WORKER_MANUAL_INTERVENTION_KIND,
      reasonCode: "effect-outcome-unknown",
    }));

    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
      manualIntervention: {
        reasonCode: "effect-outcome-unknown",
      },
      cause: expect.objectContaining({
        code: "BROKER_WORKER_MANUAL_INTERVENTION",
      }),
    });
    expect(harness.sessions[1].release).not.toHaveBeenCalled();
    expect(harness.refusalInputs).toHaveLength(0);
  });

  it("never releases an invalidated authority after the effect starts", async () => {
    let drifted = false;
    const harness = createHarness({
      revalidateExecutionAuthority(snapshot) {
        return drifted ? { ...snapshot, bootIdSha256: sha256("worker-drifted-boot") } : snapshot;
      },
    });
    harness.driver.execute = vi.fn(async () => {
      drifted = true;
      return harness.driverTerminal;
    });

    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
      cause: expect.objectContaining({
        code: "BROKER_EXECUTION_AUTHORITY_DRIFT",
      }),
    });
    expect(harness.state.currentState).toBe("effect-committed");
    expect(harness.sessions[0].release).not.toHaveBeenCalled();
    expect(harness.refusalInputs).toHaveLength(0);
  });

  it("treats a lost effect-authorization acknowledgement as post-effect", async () => {
    const harness = createHarness({
      afterEffectAuthorized: async () => {
        throw new Error("simulated lost effect authorization acknowledgement");
      },
    });

    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
      cause: expect.objectContaining({
        message: "simulated lost effect authorization acknowledgement",
      }),
    });
    expect(harness.state.currentState).toBe("effect-started");
    expect(harness.driver.execute).not.toHaveBeenCalled();
    expect(harness.sessions[0].release).not.toHaveBeenCalled();
    expect(harness.refusalInputs).toHaveLength(0);
  });

  it("releases when failed effect authorization is durably still pre-effect", async () => {
    const harness = createHarness({
      beforeEffectAuthorized: async () => {
        throw new Error("simulated pre-commit effect authorization failure");
      },
    });

    await expect(harness.worker().run()).rejects.toThrow(
      /pre-commit effect authorization failure/u,
    );
    expect(harness.state.currentState).toBe("accepted");
    expect(harness.driver.execute).not.toHaveBeenCalled();
    expect(harness.sessions[0].release).toHaveBeenCalledOnce();
    expect(harness.refusalInputs).toHaveLength(0);
  });

  it("re-reads durable retention before releasing after a lost acknowledgement", async () => {
    let loseAcknowledgement = true;
    const harness = createHarness({
      afterResultRetained: async () => {
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated lost result retention acknowledgement");
        }
      },
    });

    await expect(harness.worker().run()).rejects.toThrow(/lost result retention acknowledgement/u);
    expect(harness.state.currentState).toBe("result-retained");
    expect(harness.sessions[0].release).toHaveBeenCalledOnce();
    await expect(harness.worker().run()).resolves.toMatchObject({
      disposition: "replayed-retained-result",
    });
    expect(harness.driver.execute).toHaveBeenCalledOnce();
    expect(harness.driver.validateRequest).toHaveBeenCalledOnce();
    expect(harness.refusalInputs).toHaveLength(0);
  });

  it("rejects a second same-process worker while the physical executor is live", async () => {
    const harness = createHarness();
    let announceExecution!: () => void;
    let unblockExecution!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      announceExecution = resolve;
    });
    const executionGate = new Promise<void>((resolve) => {
      unblockExecution = resolve;
    });
    harness.driver.execute = vi.fn(async () => {
      announceExecution();
      await executionGate;
      return harness.driverTerminal;
    });

    const first = harness.worker().run();
    await executionStarted;
    await expect(harness.worker().run()).rejects.toMatchObject({
      code: "BROKER_WORKER_OPERATION_ACTIVE",
    });
    unblockExecution();
    await expect(first).resolves.toMatchObject({ disposition: "published-result" });

    expect(harness.driver.execute).toHaveBeenCalledOnce();
    expect(harness.driver.reconcile).not.toHaveBeenCalled();
    expect(harness.state.currentState).toBe("result-retained");
    expect(harness.sessions).toHaveLength(1);
    expect(harness.refusalInputs).toHaveLength(0);
  });

  it("selects the prepared driver before opening native authority or reading mail", () => {
    const harness = createHarness();
    const unavailableDriver = {
      ...harness.driver,
      driverId: "another-driver",
    };

    expect(() => harness.worker({ driverRegistry: [unavailableDriver] })).toThrowError(
      expect.objectContaining({ code: "BROKER_WORKER_UNSUPPORTED_DRIVER" }),
    );
    expect(dependencyMocks.openNativeAuthoritySession).not.toHaveBeenCalled();
    expect(dependencyMocks.openMailbox).not.toHaveBeenCalled();
  });
});
