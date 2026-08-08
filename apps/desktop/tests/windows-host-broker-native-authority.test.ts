import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  assertProbeBrokerExecutionAuthorityLease,
  bindProbeBrokerExecutionAuthorityLeaseToOperation,
  confirmProbeBrokerExecutionAuthority,
  discardProbeBrokerExecutionAuthorityConfirmation,
  markProbeBrokerExecutionAuthorityEffectStarted,
  markProbeBrokerExecutionAuthorityResultRetained,
} from "../scripts/windows-host-falsifier/broker/execution-authority.mjs";
import {
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
  type ProbePreparedBrokerEnrollment,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import {
  assertProbeBrokerTaskMatchesPreparedOperationAuthority,
  createProbeBrokerMailboxObservationFromNativeStorage,
  createProbeBrokerPreparedOperationAuthority,
  deriveProbeBrokerPreparedOperationAuthorityDigest,
  openProbeBrokerNativeAuthoritySession,
  validateProbeBrokerPreparedOperationAuthority,
  type ProbeBrokerNativeContextChannel,
  type ProbeBrokerPreparedOperationAuthority,
} from "../scripts/windows-host-falsifier/broker/native-authority.mjs";
import {
  createProbeBrokerTask,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  type ProbeBrokerExecutionMapping,
  type ProbeBrokerTask,
} from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  deriveNativeBrokerContextObservationDigest,
  deriveNativeBrokerContextReceiptDigest,
  type NativeBrokerContextReceipt,
  type NativeBuild,
} from "../scripts/windows-host-falsifier/native-client.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import { hashProbeCanonicalJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { deriveProbeRuntimeScenarioOperationId } from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { PROBE_RUN_PLAN } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const build = Object.freeze({}) as NativeBuild;
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});

function createTask(
  binding: ProbePreparedBrokerEnrollment,
  options: { readonly attemptId?: string; readonly taskId?: string } = {},
): ProbeBrokerTask {
  const definition = getProbeScenarioDefinition("F-01", "f01-ordinary-absolute-path");
  const plannedAction = definition.actions.find(
    (action) => action.actionId === "prepare-home-topology",
  )!;
  const execution = getProbeActionMapping({
    schemaVersion: 1,
    kind: "windows-host-probe-scenario-action-invocation",
    rowId: definition.rowId,
    variantId: definition.variantId,
    planSha256: definition.planSha256,
    action: plannedAction,
  }) as ProbeBrokerExecutionMapping;
  const campaignRunId = "campaign-run-a";
  const executionRunId = "execution-run-a";
  const attemptId = options.attemptId ?? "attempt-a";
  const workItem = PROBE_RUN_PLAN.work.find(
    (candidate) =>
      candidate.environmentId === binding.environmentId &&
      candidate.pathProfileId === "ascii" &&
      candidate.rowId === definition.rowId &&
      candidate.variantId === definition.variantId,
  )!;
  const operationId = deriveProbeRuntimeScenarioOperationId(
    { campaignRunId, attemptId, workId: workItem.workId },
    plannedAction.actionId,
  );
  const expectedActor = {
    role: binding.brokerRole,
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
  const driverRequestBytes = Buffer.from("native-authority-driver-request", "utf8");
  const driverRequestSha256 = sha256(driverRequestBytes);
  return createProbeBrokerTask(
    {
      taskId: options.taskId ?? `task-${attemptId}`,
      controllerIdentitySha256: sha256("controller-identity"),
      controllerPublicKeySha256: sha256(controllerPublicKeyBytes),
      candidateSha256: sha256("candidate"),
      runAuthorizationClaimReceiptSha256: sha256("run-authorization-claim-receipt"),
      coordinate: {
        campaignRunId,
        executionRunId,
        attemptId,
        workId: workItem.workId,
        environmentId: binding.environmentId,
        pathProfileId: "ascii",
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
        requestArtifact: {
          blobPath: `blobs/sha256/${driverRequestSha256}`,
          bytes: driverRequestBytes.byteLength,
          sha256: driverRequestSha256,
        },
      },
      recoveryClass: "inspect-and-reconcile",
      issuedAt: "2098-12-31T23:55:00.000Z",
      deadline: "2099-01-01T00:00:00.000Z",
      nonceBase64: Buffer.alloc(32, 7).toString("base64"),
    },
    (digest) => sign(null, digest, controllerKeys.privateKey),
  );
}

function authorityFromTask(
  task: ProbeBrokerTask,
  binding: ProbePreparedBrokerEnrollment,
  overrides: Partial<{
    readonly runtimeActionIntentSha256: string;
    readonly operationId: string;
    readonly producerActionId: string;
    readonly driverId: string;
  }> = {},
) {
  const fields = {
    preparedRunGenerationSha256: sha256("prepared-run-generation"),
    controllerIdentitySha256: task.controllerIdentitySha256,
    controllerPublicKeySha256: task.controllerPublicKeySha256,
    candidateSha256: task.candidateSha256,
    runAuthorizationClaimReceiptSha256: task.runAuthorizationClaimReceiptSha256,
    coordinate: task.coordinate,
    runtimeActionIntentSha256:
      overrides.runtimeActionIntentSha256 ?? task.runtimeActionIntentSha256,
    operationId: overrides.operationId ?? task.action.operationId,
    producerActionId: overrides.producerActionId ?? task.action.producerActionId,
    driverId: overrides.driverId ?? task.execution.driverId,
    brokerEnrollmentSha256: binding.brokerEnrollmentSha256,
    preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
    brokerInstanceId: binding.brokerInstanceId,
    brokerRole: binding.brokerRole,
  } as const;
  return createProbeBrokerPreparedOperationAuthority({
    ...fields,
    semanticKeySha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-broker-semantic-operation.v1",
      controllerIdentitySha256: fields.controllerIdentitySha256,
      brokerEnrollmentSha256: fields.brokerEnrollmentSha256,
      candidateSha256: fields.candidateSha256,
      runAuthorizationClaimReceiptSha256: fields.runAuthorizationClaimReceiptSha256,
      coordinate: fields.coordinate,
      runtimeActionIntentSha256: fields.runtimeActionIntentSha256,
      operationId: fields.operationId,
      producerActionId: fields.producerActionId,
    }),
    physicalOperationKeySha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-broker-physical-operation.v1",
      controllerIdentitySha256: fields.controllerIdentitySha256,
      brokerEnrollmentSha256: fields.brokerEnrollmentSha256,
      runtimeActionIntentSha256: fields.runtimeActionIntentSha256,
      operationId: fields.operationId,
      producerActionId: fields.producerActionId,
    }),
  });
}

function nativeAuthorityFixture() {
  const mailboxRoot = "E:\\Broker\\win11-current\\primary-mailbox";
  const journalRoot = "E:\\Broker\\win11-current\\primary-journal";
  const facts = {
    mailboxSecurityProfile: "role-separated-immutable-file-mailbox-v1" as const,
    nativeHelperSha256: sha256("native-helper"),
    mailboxRequestedPathSha256: sha256(mailboxRoot),
    mailboxPathSha256: sha256(
      "\\\\?\\Volume{fixture-volume}\\Broker\\win11-current\\primary-mailbox",
    ),
    mailboxRootObjectIdentitySha256: sha256("mailbox-root-object"),
    mailboxVolumeIdSha256: sha256("mailbox-volume"),
    mailboxOwnerSidSha256: sha256("primary-process-sid"),
    mailboxAclSha256: sha256("primary-mailbox-acl"),
    processSidSha256: sha256("primary-process-sid"),
    authenticationLuidSha256: sha256("authentication-luid"),
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("runner-session"),
    mailboxTransportIdentitySha256: sha256("mailbox-transport"),
    mailboxFileSystem: "NTFS" as const,
    mailboxDriveType: "fixed" as const,
    mailboxLocalAbsolute: true as const,
    mailboxNetworkPath: false as const,
    mailboxReparsePoint: false as const,
    journalSecurityProfile: "role-separated-append-only-journal-v1" as const,
    journalRootRequestedPathSha256: sha256(journalRoot),
    journalRootPathSha256: sha256(
      "\\\\?\\Volume{fixture-volume}\\Broker\\win11-current\\primary-journal",
    ),
    journalRootObjectIdentitySha256: sha256("journal-root-object"),
    journalVolumeIdSha256: sha256("journal-volume"),
    journalRootOwnerSidSha256: sha256("primary-process-sid"),
    journalRootAclSha256: sha256("journal-root-acl"),
    journalDatabasePathSha256: sha256(
      "\\\\?\\Volume{fixture-volume}\\Broker\\win11-current\\primary-journal\\broker-journal.sqlite",
    ),
    journalDatabaseObjectIdentitySha256: sha256("journal-database-object"),
    journalDatabaseOwnerSidSha256: sha256("primary-process-sid"),
    journalDatabaseAclSha256: sha256("journal-database-acl"),
    journalTransportIdentitySha256: sha256("journal-transport"),
    journalFileSystem: "NTFS" as const,
    journalDriveType: "fixed" as const,
    journalLocalAbsolute: true as const,
    journalNetworkPath: false as const,
    journalReparsePoint: false as const,
    interactiveSessionActive: true as const,
  };

  function receipt<K extends NativeBrokerContextReceipt["kind"]>(
    kind: K,
    sequence: number,
    previousReceiptSha256: string | null,
    overrides: Partial<typeof facts> = {},
  ): NativeBrokerContextReceipt & { readonly kind: K } {
    const receiptFacts = { ...facts, ...overrides };
    const observationDraft = {
      protocolVersion: 1 as const,
      kind,
      sequence,
      challengeSha256: sha256(`challenge-${sequence}`),
      previousReceiptSha256,
      ...receiptFacts,
    };
    const nativeObservationSha256 = deriveNativeBrokerContextObservationDigest(observationDraft);
    const receiptDraft = { ...observationDraft, nativeObservationSha256 };
    return {
      ...receiptDraft,
      receiptSha256: deriveNativeBrokerContextReceiptDigest(receiptDraft),
    } as NativeBrokerContextReceipt & { readonly kind: K };
  }

  const acquired = receipt("windows-host-native-broker-context-acquired", 1, null);
  const enrollment = createProbeBrokerEnrollment({
    environmentId: "win11-current",
    brokerRole: "primary-standard-user",
    brokerInstanceId: "win11-current-primary-broker",
    mailboxRoot,
    mailboxAclSha256: facts.mailboxAclSha256,
    journalRoot,
    journalRootAclSha256: facts.journalRootAclSha256,
    journalDatabaseAclSha256: facts.journalDatabaseAclSha256,
    processSidSha256: facts.processSidSha256,
    peerAuthoritySha256: null,
  });
  const preparedMailboxBinding = createProbePreparedBrokerEnrollment(enrollment, {
    schemaVersion: 1,
    kind: "windows-host-probe-broker-mailbox-observation",
    brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
    environmentId: enrollment.environmentId,
    brokerRole: enrollment.brokerRole,
    brokerInstanceId: enrollment.brokerInstanceId,
    mailboxRoot: enrollment.mailboxRoot,
    mailboxSecurityProfile: enrollment.mailboxSecurityProfile,
    mailboxAclSha256: acquired.mailboxAclSha256,
    mailboxOwnerSidSha256: acquired.mailboxOwnerSidSha256,
    processSidSha256: acquired.processSidSha256,
    peerAuthoritySha256: enrollment.peerAuthoritySha256,
    mailboxRootObjectIdentitySha256: acquired.mailboxRootObjectIdentitySha256,
    mailboxVolumeIdSha256: acquired.mailboxVolumeIdSha256,
    mailboxTransportIdentitySha256: acquired.mailboxTransportIdentitySha256,
    mailboxFileSystem: acquired.mailboxFileSystem,
    mailboxDriveType: acquired.mailboxDriveType,
    mailboxLocalAbsolute: acquired.mailboxLocalAbsolute,
    mailboxNetworkPath: acquired.mailboxNetworkPath,
    mailboxReparsePoint: acquired.mailboxReparsePoint,
    journalRoot,
    journalSecurityProfile: enrollment.journalSecurityProfile,
    journalRootPathSha256: acquired.journalRootPathSha256,
    journalRootObjectIdentitySha256: acquired.journalRootObjectIdentitySha256,
    journalVolumeIdSha256: acquired.journalVolumeIdSha256,
    journalRootOwnerSidSha256: acquired.journalRootOwnerSidSha256,
    journalRootAclSha256: acquired.journalRootAclSha256,
    journalDatabasePathSha256: acquired.journalDatabasePathSha256,
    journalDatabaseObjectIdentitySha256: acquired.journalDatabaseObjectIdentitySha256,
    journalDatabaseOwnerSidSha256: acquired.journalDatabaseOwnerSidSha256,
    journalDatabaseAclSha256: acquired.journalDatabaseAclSha256,
    journalTransportIdentitySha256: acquired.journalTransportIdentitySha256,
    journalFileSystem: acquired.journalFileSystem,
    journalDriveType: acquired.journalDriveType,
    journalLocalAbsolute: acquired.journalLocalAbsolute,
    journalNetworkPath: acquired.journalNetworkPath,
    journalReparsePoint: acquired.journalReparsePoint,
    bootIdSha256: acquired.bootIdSha256,
    runnerSessionIdSha256: acquired.runnerSessionIdSha256,
    nativeHelperSha256: acquired.nativeHelperSha256,
    nativeObservationSha256: acquired.nativeObservationSha256,
  });
  const task = createTask(preparedMailboxBinding);
  const preparedOperationAuthority = authorityFromTask(task, preparedMailboxBinding);

  return {
    acquired,
    enrollment,
    facts,
    preparedMailboxBinding,
    preparedOperationAuthority,
    receipt,
    task,
  };
}

function authorityRequest(
  binding: ReturnType<typeof nativeAuthorityFixture>["preparedMailboxBinding"],
) {
  return {
    preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
    brokerEnrollmentSha256: binding.brokerEnrollmentSha256,
    environmentId: binding.environmentId,
    brokerRole: binding.brokerRole,
    brokerInstanceId: binding.brokerInstanceId,
    mailboxRoot: binding.mailboxRoot,
  };
}

function nativeChannel(
  fixture: ReturnType<typeof nativeAuthorityFixture>,
  options: {
    readonly acquired?: NativeBrokerContextReceipt;
    readonly revalidate?: (...args: unknown[]) => Promise<NativeBrokerContextReceipt>;
    readonly release?: (...args: unknown[]) => Promise<unknown>;
  } = {},
) {
  let previousReceiptSha256 = (options.acquired ?? fixture.acquired).receiptSha256;
  let sequence = 1;
  let live = true;
  const revalidate = vi.fn(
    options.revalidate ??
      (async (...args: unknown[]) => {
        expect(args).toEqual([]);
        if (!live) throw new Error("native context channel is closed");
        sequence += 1;
        const observed = fixture.receipt(
          "windows-host-native-broker-context-revalidated",
          sequence,
          previousReceiptSha256,
        );
        previousReceiptSha256 = observed.receiptSha256;
        return observed;
      }),
  );
  const release = vi.fn(
    options.release ??
      (async (...args: unknown[]) => {
        expect(args).toEqual([]);
        live = false;
      }),
  );
  const channel: ProbeBrokerNativeContextChannel = {
    acquired: options.acquired ?? fixture.acquired,
    revalidate,
    release,
  };
  return { channel, release, revalidate };
}

async function openSession(
  fixture: ReturnType<typeof nativeAuthorityFixture>,
  channel: ProbeBrokerNativeContextChannel,
  authority: ProbeBrokerPreparedOperationAuthority = fixture.preparedOperationAuthority,
) {
  const openContextChannel = vi.fn(async (...args: unknown[]) => {
    expect(args).toEqual([]);
    return channel;
  });
  const session = await openProbeBrokerNativeAuthoritySession({
    build,
    preparedMailboxBinding: fixture.preparedMailboxBinding,
    preparedOperationAuthority: authority,
    expectedPreparedOperationAuthoritySha256: authority.preparedOperationAuthoritySha256,
    openContextChannel,
  });
  expect(openContextChannel.mock.calls).toEqual([[]]);
  return { openContextChannel, session };
}

describe("Windows host broker native authority", () => {
  it("projects an exact ACL-bound enrollment from a native storage observation", () => {
    const fixture = nativeAuthorityFixture();
    const observation = fixture.receipt("windows-host-native-broker-storage-observed", 1, null);

    const projected = createProbeBrokerMailboxObservationFromNativeStorage({
      brokerEnrollment: fixture.enrollment,
      nativeHelperSha256: fixture.facts.nativeHelperSha256,
      observation,
    });

    expect(projected).toMatchObject({
      brokerEnrollmentSha256: fixture.enrollment.brokerEnrollmentSha256,
      environmentId: fixture.enrollment.environmentId,
      brokerRole: fixture.enrollment.brokerRole,
      brokerInstanceId: fixture.enrollment.brokerInstanceId,
      mailboxRoot: fixture.enrollment.mailboxRoot,
      mailboxAclSha256: fixture.enrollment.mailboxAclSha256,
      mailboxOwnerSidSha256: fixture.enrollment.processSidSha256,
      journalRoot: fixture.enrollment.journalRoot,
      journalRootAclSha256: fixture.enrollment.journalRootAclSha256,
      journalDatabaseAclSha256: fixture.enrollment.journalDatabaseAclSha256,
      nativeHelperSha256: fixture.facts.nativeHelperSha256,
      nativeObservationSha256: observation.nativeObservationSha256,
    });
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it.each([
    "mailboxAclSha256",
    "mailboxOwnerSidSha256",
    "processSidSha256",
    "journalRootAclSha256",
    "journalRootOwnerSidSha256",
    "journalDatabaseAclSha256",
    "journalDatabaseOwnerSidSha256",
    "nativeHelperSha256",
  ] as const)("rejects native storage observation drift in %s", (key) => {
    const fixture = nativeAuthorityFixture();
    const observation = fixture.receipt("windows-host-native-broker-storage-observed", 1, null, {
      [key]: sha256(`substituted-storage-${key}`),
    });

    expect(() =>
      createProbeBrokerMailboxObservationFromNativeStorage({
        brokerEnrollment: fixture.enrollment,
        nativeHelperSha256: fixture.facts.nativeHelperSha256,
        observation,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "BROKER_NATIVE_AUTHORITY_ENROLLMENT_MISMATCH",
      }),
    );
  });

  it("rejects selector-bearing native storage observation options", () => {
    const fixture = nativeAuthorityFixture();

    expect(() =>
      createProbeBrokerMailboxObservationFromNativeStorage({
        brokerEnrollment: fixture.enrollment,
        nativeHelperSha256: fixture.facts.nativeHelperSha256,
        observation: fixture.receipt("windows-host-native-broker-storage-observed", 1, null),
        taskSha256: sha256("forbidden-task-selector"),
      } as never),
    ).toThrowError(expect.objectContaining({ code: "BROKER_NATIVE_AUTHORITY_SCHEMA" }));
  });

  it("creates an independently digested, immutable prepared operation authority", () => {
    const { preparedOperationAuthority, task } = nativeAuthorityFixture();

    expect(preparedOperationAuthority.preparedOperationAuthoritySha256).toBe(
      deriveProbeBrokerPreparedOperationAuthorityDigest(preparedOperationAuthority),
    );
    expect(preparedOperationAuthority.semanticKeySha256).toBe(
      deriveProbeBrokerTaskSemanticKeySha256(task),
    );
    expect(preparedOperationAuthority.physicalOperationKeySha256).toBe(
      deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    );
    expect(validateProbeBrokerPreparedOperationAuthority(preparedOperationAuthority)).toEqual(
      preparedOperationAuthority,
    );
    expect(Object.isFrozen(preparedOperationAuthority)).toBe(true);
    expect(Object.isFrozen(preparedOperationAuthority.coordinate)).toBe(true);
    expect(() =>
      validateProbeBrokerPreparedOperationAuthority({
        ...preparedOperationAuthority,
        driverId: "substituted-driver",
      }),
    ).toThrowError(expect.objectContaining({ code: "BROKER_NATIVE_AUTHORITY_DIGEST" }));
  });

  it("matches only the exact signed task action, physical operation, and driver", () => {
    const fixture = nativeAuthorityFixture();

    expect(
      assertProbeBrokerTaskMatchesPreparedOperationAuthority(
        fixture.task,
        fixture.preparedOperationAuthority,
      ),
    ).toEqual(fixture.task);

    for (const substitutedAuthority of [
      authorityFromTask(fixture.task, fixture.preparedMailboxBinding, {
        runtimeActionIntentSha256: sha256("substituted-runtime-action"),
      }),
      authorityFromTask(fixture.task, fixture.preparedMailboxBinding, {
        operationId: "substituted-operation",
      }),
      authorityFromTask(fixture.task, fixture.preparedMailboxBinding, {
        producerActionId: "substituted-producer-action",
      }),
      authorityFromTask(fixture.task, fixture.preparedMailboxBinding, {
        driverId: "substituted-driver",
      }),
    ]) {
      expect(() =>
        assertProbeBrokerTaskMatchesPreparedOperationAuthority(fixture.task, substitutedAuthority),
      ).toThrowError(expect.objectContaining({ code: "BROKER_NATIVE_AUTHORITY_TASK_BINDING" }));
    }
  });

  it("requires the external authority digest before opening any native channel", async () => {
    const fixture = nativeAuthorityFixture();
    const openContextChannel = vi.fn();

    await expect(
      openProbeBrokerNativeAuthoritySession({
        build,
        preparedMailboxBinding: fixture.preparedMailboxBinding,
        preparedOperationAuthority: fixture.preparedOperationAuthority,
        expectedPreparedOperationAuthoritySha256: sha256("substituted-startup-pin"),
        openContextChannel,
      }),
    ).rejects.toMatchObject({ code: "BROKER_NATIVE_AUTHORITY_TRUST_ANCHOR" });
    expect(openContextChannel).not.toHaveBeenCalled();
  });

  it("opens and revalidates without task selectors while pinning the exact operation and action", async () => {
    const fixture = nativeAuthorityFixture();
    const channel = nativeChannel(fixture);
    const { session } = await openSession(fixture, channel.channel);

    const snapshot = assertProbeBrokerExecutionAuthorityLease(
      session.executionAuthorityLease,
    ).snapshot;
    expect(snapshot).toMatchObject({
      preparedRunGenerationSha256: fixture.preparedOperationAuthority.preparedRunGenerationSha256,
      controllerIdentitySha256: fixture.preparedOperationAuthority.controllerIdentitySha256,
      candidateSha256: fixture.preparedOperationAuthority.candidateSha256,
      runAuthorizationClaimReceiptSha256:
        fixture.preparedOperationAuthority.runAuthorizationClaimReceiptSha256,
      coordinate: fixture.preparedOperationAuthority.coordinate,
      physicalOperationKeySha256: fixture.preparedOperationAuthority.physicalOperationKeySha256,
      runtimeActionIntentSha256: fixture.preparedOperationAuthority.runtimeActionIntentSha256,
      operationId: fixture.preparedOperationAuthority.operationId,
      producerActionId: fixture.preparedOperationAuthority.producerActionId,
      driverId: fixture.preparedOperationAuthority.driverId,
      preparedBrokerEnrollmentSha256: fixture.preparedMailboxBinding.preparedBrokerEnrollmentSha256,
    });
    bindProbeBrokerExecutionAuthorityLeaseToOperation(
      session.executionAuthorityLease,
      fixture.preparedOperationAuthority.physicalOperationKeySha256,
    );
    expect(() =>
      bindProbeBrokerExecutionAuthorityLeaseToOperation(
        session.executionAuthorityLease,
        sha256("another-physical-operation"),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "BROKER_EXECUTION_AUTHORITY_OPERATION_BINDING",
      }),
    );

    const journalConfirmation = await confirmProbeBrokerExecutionAuthority(
      session.executionAuthorityLease,
      "journal-consumption",
    );
    discardProbeBrokerExecutionAuthorityConfirmation(
      session.executionAuthorityLease,
      journalConfirmation,
      "journal-consumption",
    );
    expect(channel.revalidate.mock.calls).toEqual([[]]);
    await session.release();
    expect(channel.release.mock.calls).toEqual([[]]);
  });

  it("uses one live native channel for execution and task-independent mailbox authority", async () => {
    const fixture = nativeAuthorityFixture();
    const channel = nativeChannel(fixture);
    const { openContextChannel, session } = await openSession(fixture, channel.channel);

    const observed = await session.assertMailboxAuthority(
      authorityRequest(fixture.preparedMailboxBinding),
    );
    expect(observed).toMatchObject({
      brokerEnrollmentSha256: fixture.preparedMailboxBinding.brokerEnrollmentSha256,
      brokerInstanceId: fixture.preparedMailboxBinding.brokerInstanceId,
      mailboxRootObjectIdentitySha256:
        fixture.preparedMailboxBinding.mailboxRootObjectIdentitySha256,
      nativeObservationSha256: fixture.preparedMailboxBinding.nativeObservationSha256,
    });
    expect(observed).not.toHaveProperty("preparedBrokerEnrollmentSha256");
    const acceptanceConfirmation = await confirmProbeBrokerExecutionAuthority(
      session.executionAuthorityLease,
      "acceptance",
    );
    discardProbeBrokerExecutionAuthorityConfirmation(
      session.executionAuthorityLease,
      acceptanceConfirmation,
      "acceptance",
    );
    expect(openContextChannel).toHaveBeenCalledOnce();
    expect(channel.revalidate.mock.calls).toEqual([[], [], []]);

    await expect(
      session.assertMailboxAuthority({
        ...authorityRequest(fixture.preparedMailboxBinding),
        taskSha256: sha256("forbidden-task-selector"),
      } as never),
    ).rejects.toMatchObject({ code: "BROKER_NATIVE_AUTHORITY_SCHEMA" });
    await expect(
      session.assertMailboxAuthority({
        ...authorityRequest(fixture.preparedMailboxBinding),
        brokerInstanceId: "substituted-broker",
      }),
    ).rejects.toMatchObject({ code: "BROKER_NATIVE_AUTHORITY_REQUEST" });
    expect(channel.revalidate.mock.calls).toEqual([[], [], []]);

    await session.release();
  });

  it.each([
    "mailboxRootObjectIdentitySha256",
    "mailboxVolumeIdSha256",
    "mailboxOwnerSidSha256",
    "mailboxAclSha256",
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "mailboxTransportIdentitySha256",
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
    "nativeHelperSha256",
  ] as const)("rejects an acquired receipt with substituted %s", async (key) => {
    const fixture = nativeAuthorityFixture();
    const substituted = fixture.receipt("windows-host-native-broker-context-acquired", 1, null, {
      [key]: sha256(`substituted-${key}`),
    });
    const channel = nativeChannel(fixture, { acquired: substituted });

    await expect(openSession(fixture, channel.channel)).rejects.toMatchObject({
      code: "BROKER_NATIVE_AUTHORITY_PREPARED_MISMATCH",
    });
  });

  it("rejects a different native observation even when unexported receipt facts caused it", async () => {
    const fixture = nativeAuthorityFixture();
    const substituted = fixture.receipt("windows-host-native-broker-context-acquired", 1, null, {
      authenticationLuidSha256: sha256("another-authentication-luid"),
    });
    const channel = nativeChannel(fixture, { acquired: substituted });

    await expect(openSession(fixture, channel.channel)).rejects.toMatchObject({
      code: "BROKER_NATIVE_AUTHORITY_PREPARED_MISMATCH",
    });
  });

  it("permanently invalidates drift during revalidation and still closes the native channel", async () => {
    const fixture = nativeAuthorityFixture();
    const drifted = fixture.receipt(
      "windows-host-native-broker-context-revalidated",
      2,
      fixture.acquired.receiptSha256,
      { bootIdSha256: sha256("another-boot") },
    );
    const channel = nativeChannel(fixture, {
      revalidate: async (...args: unknown[]) => {
        expect(args).toEqual([]);
        return drifted;
      },
    });
    const { session } = await openSession(fixture, channel.channel);

    await expect(
      confirmProbeBrokerExecutionAuthority(session.executionAuthorityLease, "physical-execution"),
    ).rejects.toMatchObject({ code: "BROKER_NATIVE_AUTHORITY_PREPARED_MISMATCH" });
    await expect(
      confirmProbeBrokerExecutionAuthority(session.executionAuthorityLease, "physical-execution"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
    await session.release();
    expect(channel.release).toHaveBeenCalledOnce();
  });

  it("does not close a live channel after effect start until its result is retained", async () => {
    const fixture = nativeAuthorityFixture();
    const channel = nativeChannel(fixture);
    const { session } = await openSession(fixture, channel.channel);
    markProbeBrokerExecutionAuthorityEffectStarted(session.executionAuthorityLease);

    await expect(session.release()).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_INCOMPLETE",
    });
    expect(channel.release).not.toHaveBeenCalled();

    markProbeBrokerExecutionAuthorityResultRetained(session.executionAuthorityLease);
    await session.release();
    expect(channel.release).toHaveBeenCalledOnce();
  });

  it("closes the native channel when an acquired receipt fails prepared binding", async () => {
    const fixture = nativeAuthorityFixture();
    const substituted = fixture.receipt("windows-host-native-broker-context-acquired", 1, null, {
      mailboxAclSha256: sha256("substituted-mailbox-acl"),
    });
    const channel = nativeChannel(fixture, { acquired: substituted });

    await expect(openSession(fixture, channel.channel)).rejects.toMatchObject({
      code: "BROKER_NATIVE_AUTHORITY_PREPARED_MISMATCH",
    });
    expect(channel.release).toHaveBeenCalledOnce();
  });

  it("requires process termination when an invalid acquired channel cannot be released", async () => {
    const fixture = nativeAuthorityFixture();
    const substituted = fixture.receipt("windows-host-native-broker-context-acquired", 1, null, {
      mailboxAclSha256: sha256("substituted-mailbox-acl"),
    });
    const releaseFailure = new Error("synthetic native release failure");
    const channel = nativeChannel(fixture, {
      acquired: substituted,
      release: async () => {
        throw releaseFailure;
      },
    });

    await expect(openSession(fixture, channel.channel)).rejects.toMatchObject({
      code: "BROKER_NATIVE_AUTHORITY_RELEASE",
      requiresProcessExit: true,
    });
    expect(channel.release).toHaveBeenCalledOnce();
  });

  it("requires process termination when an incomplete native channel cannot be released", async () => {
    const fixture = nativeAuthorityFixture();
    const release = vi.fn(async () => {
      throw new Error("synthetic incomplete-channel release failure");
    });

    await expect(
      openProbeBrokerNativeAuthoritySession({
        build,
        preparedMailboxBinding: fixture.preparedMailboxBinding,
        preparedOperationAuthority: fixture.preparedOperationAuthority,
        expectedPreparedOperationAuthoritySha256:
          fixture.preparedOperationAuthority.preparedOperationAuthoritySha256,
        openContextChannel: async () =>
          ({
            acquired: fixture.acquired,
            revalidate: null,
            release,
          }) as never,
      }),
    ).rejects.toMatchObject({
      code: "BROKER_NATIVE_AUTHORITY_RELEASE",
      requiresProcessExit: true,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("requires process termination when an opened native channel exposes no release", async () => {
    const fixture = nativeAuthorityFixture();

    await expect(
      openProbeBrokerNativeAuthoritySession({
        build,
        preparedMailboxBinding: fixture.preparedMailboxBinding,
        preparedOperationAuthority: fixture.preparedOperationAuthority,
        expectedPreparedOperationAuthoritySha256:
          fixture.preparedOperationAuthority.preparedOperationAuthoritySha256,
        openContextChannel: async () =>
          ({
            acquired: fixture.acquired,
            revalidate: async () => fixture.acquired,
          }) as never,
      }),
    ).rejects.toMatchObject({
      code: "BROKER_NATIVE_AUTHORITY_CHANNEL",
      requiresProcessExit: true,
    });
  });

  it("releases without invoking an accessor-backed native revalidator", async () => {
    const fixture = nativeAuthorityFixture();
    const release = vi.fn(async () => undefined);
    const revalidateGetter = vi.fn(() => {
      throw new Error("revalidate accessor must not run");
    });
    const channel = Object.create(null);
    Object.defineProperties(channel, {
      acquired: { enumerable: true, value: fixture.acquired },
      revalidate: { enumerable: true, get: revalidateGetter },
      release: { enumerable: true, value: release },
    });

    await expect(
      openProbeBrokerNativeAuthoritySession({
        build,
        preparedMailboxBinding: fixture.preparedMailboxBinding,
        preparedOperationAuthority: fixture.preparedOperationAuthority,
        expectedPreparedOperationAuthoritySha256:
          fixture.preparedOperationAuthority.preparedOperationAuthoritySha256,
        openContextChannel: async () => channel,
      }),
    ).rejects.toMatchObject({ code: "BROKER_NATIVE_AUTHORITY_CHANNEL" });
    expect(revalidateGetter).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("requires process termination without invoking an accessor-backed native release", async () => {
    const fixture = nativeAuthorityFixture();
    const releaseGetter = vi.fn(() => {
      throw new Error("release accessor must not run");
    });
    const channel = Object.create(null);
    Object.defineProperties(channel, {
      acquired: { enumerable: true, value: fixture.acquired },
      revalidate: { enumerable: true, value: async () => fixture.acquired },
      release: { enumerable: true, get: releaseGetter },
    });

    await expect(
      openProbeBrokerNativeAuthoritySession({
        build,
        preparedMailboxBinding: fixture.preparedMailboxBinding,
        preparedOperationAuthority: fixture.preparedOperationAuthority,
        expectedPreparedOperationAuthoritySha256:
          fixture.preparedOperationAuthority.preparedOperationAuthoritySha256,
        openContextChannel: async () => channel,
      }),
    ).rejects.toMatchObject({
      code: "BROKER_NATIVE_AUTHORITY_CHANNEL",
      requiresProcessExit: true,
    });
    expect(releaseGetter).not.toHaveBeenCalled();
  });

  it("waits for an in-flight mailbox authority check before releasing its native channel", async () => {
    const fixture = nativeAuthorityFixture();
    let unblockRevalidation!: () => void;
    let announceRevalidation!: () => void;
    const revalidationStarted = new Promise<void>((resolve) => {
      announceRevalidation = resolve;
    });
    const revalidationGate = new Promise<void>((resolve) => {
      unblockRevalidation = resolve;
    });
    let calls = 0;
    const channel = nativeChannel(fixture, {
      revalidate: async (...args: unknown[]) => {
        expect(args).toEqual([]);
        calls += 1;
        if (calls === 1) {
          announceRevalidation();
          await revalidationGate;
        }
        return fixture.receipt(
          "windows-host-native-broker-context-revalidated",
          calls + 1,
          fixture.acquired.receiptSha256,
        );
      },
    });
    const { session } = await openSession(fixture, channel.channel);

    const mailboxCheck = session.assertMailboxAuthority(
      authorityRequest(fixture.preparedMailboxBinding),
    );
    await revalidationStarted;
    let released = false;
    const release = session.release().then(() => {
      released = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(false);
    expect(channel.release).not.toHaveBeenCalled();

    unblockRevalidation();
    await mailboxCheck;
    await release;
    expect(channel.release).toHaveBeenCalledOnce();
  });
});
