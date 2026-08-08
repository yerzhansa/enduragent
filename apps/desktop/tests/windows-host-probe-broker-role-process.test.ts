import { createHash, generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  observeNativeBrokerStorage: vi.fn(),
  createProbeBrokerWorker: vi.fn(),
  workerRun: vi.fn(),
}));

vi.mock("../scripts/windows-host-falsifier/native-client.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/windows-host-falsifier/native-client.mjs")>()),
  observeNativeBrokerStorage: dependencyMocks.observeNativeBrokerStorage,
}));

vi.mock("../scripts/windows-host-falsifier/broker/worker.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/windows-host-falsifier/broker/worker.mjs")>()),
  createProbeBrokerWorker: dependencyMocks.createProbeBrokerWorker,
}));

import {
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { createProbeBrokerPreparedOperationAuthority } from "../scripts/windows-host-falsifier/broker/native-authority.mjs";
import {
  createProbeBrokerRoleProcessHost,
  type ProbeBrokerRoleProcessHost,
} from "../scripts/windows-host-falsifier/broker/role-process-host.mjs";
import type { ProbeBrokerRole } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import type { ProbeBrokerWorkerDriver } from "../scripts/windows-host-falsifier/broker/worker.mjs";
import type { EvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import {
  deriveNativeBrokerContextObservationDigest,
  deriveNativeBrokerContextReceiptDigest,
  type NativeBrokerContextReceipt,
  type NativeBuild,
  type NativeBuildIdentity,
} from "../scripts/windows-host-falsifier/native-client.mjs";
import { hashProbeCanonicalJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});

function nativeBuild(suffix: string): NativeBuild {
  return {
    assemblyPath: `E:\\Candidate\\${suffix}\\probe-native.exe`,
    buildDirectory: `E:\\Candidate\\${suffix}`,
    candidateRoot: "E:\\Candidate",
    candidateDirectory: `E:\\Candidate\\${suffix}`,
    nativeHelperArtifactPath: `${suffix}/probe-native.exe`,
    snapshotDirectory: `E:\\Candidate\\${suffix}\\source`,
    manifestPath: `E:\\Candidate\\${suffix}\\native-candidate.json`,
    candidateDigest: sha256(`candidate:${suffix}`),
    assemblySha256: sha256(`assembly:${suffix}`),
    sourceBundleSha256: sha256(`sources:${suffix}`),
    toolchainDigest: sha256(`toolchain:${suffix}`),
    manifestSha256: sha256(`manifest:${suffix}`),
    sources: [
      {
        name: "Program.cs",
        sha256: sha256(`program:${suffix}`),
        bytes: 123,
      },
    ],
    toolchain: { compiler: "fixture-csc", version: "1" },
  };
}

function buildIdentity(build: NativeBuild): NativeBuildIdentity {
  return {
    candidateDigest: build.candidateDigest,
    assemblySha256: build.assemblySha256,
    sourceBundleSha256: build.sourceBundleSha256,
    toolchainDigest: build.toolchainDigest,
    manifestSha256: build.manifestSha256,
    sources: build.sources,
    toolchain: build.toolchain,
  };
}

function fakeStore(root: string): EvidenceStore {
  return {
    root,
    createDirectory: vi.fn(async () => root),
    writeBytes: vi.fn(async (path) => ({ path, sha256: sha256(path) })),
    writeCanonicalJson: vi.fn(async (path) => ({ path, sha256: sha256(path) })),
    readArtifact: vi.fn(async (path) => ({
      path,
      bytes: Buffer.alloc(0),
      size: 0,
      sha256: sha256(""),
    })),
    verifyArtifactSet: vi.fn(async (entries) => entries),
    scan: vi.fn(async () => ({ files: 0, totalBytes: 0, artifacts: [] })),
    list: vi.fn(async () => []),
    assertRootStable: vi.fn(async () => undefined),
  };
}

function driver(driverId = "role-process-driver"): ProbeBrokerWorkerDriver {
  return {
    driverId,
    requestSchemaSha256: sha256(`schema:${driverId}`),
    recoveryClass: "inspect-and-reconcile",
    validateRequest: vi.fn(),
    execute: vi.fn(),
    reconcile: vi.fn(),
  };
}

function fixture(suffix = "primary", brokerRole: ProbeBrokerRole = "primary-standard-user") {
  const build = nativeBuild(suffix);
  const mailboxRoot = `E:\\Broker\\${suffix}\\mailbox`;
  const journalRoot = `E:\\Broker\\${suffix}\\journal`;
  const processSidSha256 = sha256(`sid:${suffix}`);
  const enrollment = createProbeBrokerEnrollment({
    environmentId: "win11-current",
    brokerRole,
    brokerInstanceId: `${suffix}-broker`,
    mailboxRoot,
    mailboxAclSha256: sha256(`mailbox-acl:${suffix}`),
    journalRoot,
    journalRootAclSha256: sha256(`journal-root-acl:${suffix}`),
    journalDatabaseAclSha256: sha256(`journal-database-acl:${suffix}`),
    processSidSha256,
    peerAuthoritySha256: brokerRole === "remote-peer" ? sha256(`peer:${suffix}`) : null,
  });
  const observationFacts = {
    mailboxSecurityProfile: enrollment.mailboxSecurityProfile,
    nativeHelperSha256: build.assemblySha256,
    mailboxRequestedPathSha256: sha256(mailboxRoot),
    mailboxPathSha256: sha256(`\\\\?\\Volume{fixture-volume}\\Broker\\${suffix}\\mailbox`),
    mailboxRootObjectIdentitySha256: sha256(`mailbox-object:${suffix}`),
    mailboxVolumeIdSha256: sha256(`mailbox-volume:${suffix}`),
    mailboxOwnerSidSha256: processSidSha256,
    mailboxAclSha256: enrollment.mailboxAclSha256,
    processSidSha256,
    authenticationLuidSha256: sha256(`authentication-luid:${suffix}`),
    bootIdSha256: sha256(`boot:${suffix}`),
    runnerSessionIdSha256: sha256(`runner:${suffix}`),
    mailboxTransportIdentitySha256: sha256(`mailbox-transport:${suffix}`),
    mailboxFileSystem: "NTFS" as const,
    mailboxDriveType: "fixed" as const,
    mailboxLocalAbsolute: true as const,
    mailboxNetworkPath: false as const,
    mailboxReparsePoint: false as const,
    journalSecurityProfile: enrollment.journalSecurityProfile,
    journalRootRequestedPathSha256: sha256(journalRoot),
    journalRootPathSha256: sha256(`\\\\?\\Volume{fixture-volume}\\Broker\\${suffix}\\journal`),
    journalRootObjectIdentitySha256: sha256(`journal-object:${suffix}`),
    journalVolumeIdSha256: sha256(`journal-volume:${suffix}`),
    journalRootOwnerSidSha256: processSidSha256,
    journalRootAclSha256: enrollment.journalRootAclSha256,
    journalDatabasePathSha256: sha256(
      `\\\\?\\Volume{fixture-volume}\\Broker\\${suffix}\\journal\\broker-journal.sqlite`,
    ),
    journalDatabaseObjectIdentitySha256: sha256(`journal-database-object:${suffix}`),
    journalDatabaseOwnerSidSha256: processSidSha256,
    journalDatabaseAclSha256: enrollment.journalDatabaseAclSha256,
    journalTransportIdentitySha256: sha256(`journal-transport:${suffix}`),
    journalFileSystem: "NTFS" as const,
    journalDriveType: "fixed" as const,
    journalLocalAbsolute: true as const,
    journalNetworkPath: false as const,
    journalReparsePoint: false as const,
    interactiveSessionActive: true as const,
  };
  const observationDraft = {
    protocolVersion: 1 as const,
    kind: "windows-host-native-broker-storage-observed" as const,
    sequence: 1,
    challengeSha256: sha256(`challenge:${suffix}`),
    previousReceiptSha256: null,
    ...observationFacts,
  };
  const nativeObservationSha256 = deriveNativeBrokerContextObservationDigest(observationDraft);
  const receiptDraft = { ...observationDraft, nativeObservationSha256 };
  const receipt: NativeBrokerContextReceipt = {
    ...receiptDraft,
    receiptSha256: deriveNativeBrokerContextReceiptDigest(receiptDraft),
  };
  const observation = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-broker-mailbox-observation" as const,
    brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
    environmentId: enrollment.environmentId,
    brokerRole: enrollment.brokerRole,
    brokerInstanceId: enrollment.brokerInstanceId,
    mailboxRoot: enrollment.mailboxRoot,
    mailboxSecurityProfile: enrollment.mailboxSecurityProfile,
    mailboxAclSha256: receipt.mailboxAclSha256,
    mailboxOwnerSidSha256: receipt.mailboxOwnerSidSha256,
    processSidSha256: receipt.processSidSha256,
    peerAuthoritySha256: enrollment.peerAuthoritySha256,
    mailboxRootObjectIdentitySha256: receipt.mailboxRootObjectIdentitySha256,
    mailboxVolumeIdSha256: receipt.mailboxVolumeIdSha256,
    mailboxTransportIdentitySha256: receipt.mailboxTransportIdentitySha256,
    mailboxFileSystem: receipt.mailboxFileSystem,
    mailboxDriveType: receipt.mailboxDriveType,
    mailboxLocalAbsolute: receipt.mailboxLocalAbsolute,
    mailboxNetworkPath: receipt.mailboxNetworkPath,
    mailboxReparsePoint: receipt.mailboxReparsePoint,
    journalRoot: enrollment.journalRoot,
    journalSecurityProfile: enrollment.journalSecurityProfile,
    journalRootPathSha256: receipt.journalRootPathSha256,
    journalRootObjectIdentitySha256: receipt.journalRootObjectIdentitySha256,
    journalVolumeIdSha256: receipt.journalVolumeIdSha256,
    journalRootOwnerSidSha256: receipt.journalRootOwnerSidSha256,
    journalRootAclSha256: receipt.journalRootAclSha256,
    journalDatabasePathSha256: receipt.journalDatabasePathSha256,
    journalDatabaseObjectIdentitySha256: receipt.journalDatabaseObjectIdentitySha256,
    journalDatabaseOwnerSidSha256: receipt.journalDatabaseOwnerSidSha256,
    journalDatabaseAclSha256: receipt.journalDatabaseAclSha256,
    journalTransportIdentitySha256: receipt.journalTransportIdentitySha256,
    journalFileSystem: receipt.journalFileSystem,
    journalDriveType: receipt.journalDriveType,
    journalLocalAbsolute: receipt.journalLocalAbsolute,
    journalNetworkPath: receipt.journalNetworkPath,
    journalReparsePoint: receipt.journalReparsePoint,
    bootIdSha256: receipt.bootIdSha256,
    runnerSessionIdSha256: receipt.runnerSessionIdSha256,
    nativeHelperSha256: receipt.nativeHelperSha256,
    nativeObservationSha256: receipt.nativeObservationSha256,
  };
  const preparedBrokerEnrollment = createProbePreparedBrokerEnrollment(enrollment, observation);
  const coordinate = {
    campaignRunId: "role-process-campaign",
    executionRunId: "role-process-execution",
    attemptId: "role-process-attempt",
    workId: "role-process-work",
    environmentId: enrollment.environmentId,
    pathProfileId: "ascii" as const,
    rowId: "F-01" as const,
    variantId: "role-process-variant",
    repetition: null,
  };
  const authorityFields = {
    preparedRunGenerationSha256: sha256("prepared-generation"),
    controllerIdentitySha256: sha256("controller-identity"),
    controllerPublicKeySha256: sha256(controllerPublicKeyBytes),
    candidateSha256: sha256("candidate"),
    runAuthorizationClaimReceiptSha256: sha256("authorization-claim"),
    coordinate,
    runtimeActionIntentSha256: sha256("runtime-action-intent"),
    operationId: "role-process-operation",
    producerActionId: "role-process-action",
    driverId: "role-process-driver",
    brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
    preparedBrokerEnrollmentSha256: preparedBrokerEnrollment.preparedBrokerEnrollmentSha256,
    brokerInstanceId: enrollment.brokerInstanceId,
    brokerRole: enrollment.brokerRole,
  } as const;
  const preparedOperationAuthority = createProbeBrokerPreparedOperationAuthority({
    ...authorityFields,
    semanticKeySha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-broker-semantic-operation.v1",
      controllerIdentitySha256: authorityFields.controllerIdentitySha256,
      brokerEnrollmentSha256: authorityFields.brokerEnrollmentSha256,
      candidateSha256: authorityFields.candidateSha256,
      runAuthorizationClaimReceiptSha256: authorityFields.runAuthorizationClaimReceiptSha256,
      coordinate,
      runtimeActionIntentSha256: authorityFields.runtimeActionIntentSha256,
      operationId: authorityFields.operationId,
      producerActionId: authorityFields.producerActionId,
    }),
    physicalOperationKeySha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-broker-physical-operation.v1",
      controllerIdentitySha256: authorityFields.controllerIdentitySha256,
      brokerEnrollmentSha256: authorityFields.brokerEnrollmentSha256,
      runtimeActionIntentSha256: authorityFields.runtimeActionIntentSha256,
      operationId: authorityFields.operationId,
      producerActionId: authorityFields.producerActionId,
    }),
  });
  const mailboxStore = fakeStore(mailboxRoot);
  const driverRegistry = [driver()];
  const hostOptions = {
    nativeBuild: build,
    brokerEnrollment: enrollment,
    mailboxStore,
    controllerPublicKeyBytes,
    driverRegistry,
    now: () => new Date("2098-12-31T23:59:59.000Z"),
  } as const;
  const run = {
    preparedBrokerEnrollment,
    preparedOperationAuthority,
    expectedPreparedOperationAuthoritySha256:
      preparedOperationAuthority.preparedOperationAuthoritySha256,
  };
  const nativeObservationResult = Object.freeze({
    brokerEnrollment: enrollment,
    build: buildIdentity(build),
    observation: receipt,
  });
  return {
    build,
    enrollment,
    hostOptions,
    mailboxStore,
    nativeObservationResult,
    preparedBrokerEnrollment,
    preparedOperationAuthority,
    receipt,
    run,
  };
}

function createHost(values: ReturnType<typeof fixture>): ProbeBrokerRoleProcessHost {
  return createProbeBrokerRoleProcessHost(values.hostOptions);
}

beforeEach(() => {
  dependencyMocks.observeNativeBrokerStorage.mockReset();
  dependencyMocks.createProbeBrokerWorker.mockReset();
  dependencyMocks.workerRun.mockReset();
  dependencyMocks.createProbeBrokerWorker.mockReturnValue({
    run: dependencyMocks.workerRun,
  });
  dependencyMocks.workerRun.mockResolvedValue({
    schemaVersion: 1,
    kind: "windows-host-probe-broker-worker-outcome",
    disposition: "published-result",
    physicalOperationKeySha256: sha256("physical-operation"),
    taskSha256: sha256("task"),
    resultSha256: sha256("result"),
    resultEnvelopeSha256: sha256("result-envelope"),
  });
});

describe("Windows host probe broker role process", () => {
  it("pins one exact startup role and converts its native storage observation", async () => {
    const values = fixture();
    dependencyMocks.observeNativeBrokerStorage.mockResolvedValue(values.nativeObservationResult);
    const host = createHost(values);

    await expect(host.observeMailbox()).resolves.toMatchObject({
      brokerEnrollmentSha256: values.enrollment.brokerEnrollmentSha256,
      environmentId: values.enrollment.environmentId,
      brokerRole: values.enrollment.brokerRole,
      brokerInstanceId: values.enrollment.brokerInstanceId,
      mailboxAclSha256: values.enrollment.mailboxAclSha256,
      journalRootAclSha256: values.enrollment.journalRootAclSha256,
      journalDatabaseAclSha256: values.enrollment.journalDatabaseAclSha256,
      nativeHelperSha256: values.build.assemblySha256,
    });
    expect(host.identity).toMatchObject({
      brokerEnrollmentSha256: values.enrollment.brokerEnrollmentSha256,
      brokerRole: "primary-standard-user",
      nativeHelperSha256: values.build.assemblySha256,
      controllerPublicKeySha256: sha256(controllerPublicKeyBytes),
    });
    expect(host.state()).toBe("ready");
    expect(dependencyMocks.observeNativeBrokerStorage).toHaveBeenCalledWith({
      build: values.build,
      brokerEnrollment: values.enrollment,
    });
    expect(dependencyMocks.observeNativeBrokerStorage.mock.calls[0]?.[0].build).toBe(values.build);
  });

  it("rejects every substituted native-build identity field before projection", async () => {
    const values = fixture();
    const identity = buildIdentity(values.build);
    const { manifestSha256: _manifestSha256, ...missingManifest } = identity;
    const substitutions: unknown[] = [
      { ...identity, candidateDigest: sha256("substituted-candidate") },
      { ...identity, assemblySha256: sha256("substituted-assembly") },
      { ...identity, sourceBundleSha256: sha256("substituted-sources") },
      { ...identity, toolchainDigest: sha256("substituted-toolchain") },
      { ...identity, manifestSha256: sha256("substituted-manifest") },
      {
        ...identity,
        sources: identity.sources.map((source, index) =>
          index === 0 ? { ...source, bytes: source.bytes + 1 } : source,
        ),
      },
      { ...identity, toolchain: { ...identity.toolchain, version: "2" } },
      { ...identity, unexpectedIdentityField: sha256("unexpected") },
      missingManifest,
    ];
    const host = createHost(values);

    for (const substituted of substitutions) {
      dependencyMocks.observeNativeBrokerStorage.mockResolvedValue({
        ...values.nativeObservationResult,
        build: substituted,
      } as never);
      await expect(host.observeMailbox()).rejects.toMatchObject({
        code: "BROKER_ROLE_PROCESS_NATIVE_OBSERVATION",
      });
    }
    expect(host.state()).toBe("ready");
  });

  it("delegates one operation using only startup-bound roots, key, build, and drivers", async () => {
    const values = fixture();
    const host = createHost(values);

    await expect(host.runOnce(values.run)).resolves.toMatchObject({
      disposition: "published-result",
    });
    expect(host.state()).toBe("completed");
    expect(dependencyMocks.createProbeBrokerWorker).toHaveBeenCalledWith({
      nativeBuild: values.build,
      preparedBrokerEnrollment: values.preparedBrokerEnrollment,
      preparedOperationAuthority: values.preparedOperationAuthority,
      expectedPreparedOperationAuthoritySha256:
        values.preparedOperationAuthority.preparedOperationAuthoritySha256,
      mailboxStore: expect.objectContaining({ root: values.enrollment.mailboxRoot }),
      journalRoot: values.enrollment.journalRoot,
      controllerPublicKeyBytes: expect.any(Uint8Array),
      driverRegistry: expect.arrayContaining([
        expect.objectContaining({ driverId: "role-process-driver" }),
      ]),
      now: values.hostOptions.now,
    });
    expect(dependencyMocks.createProbeBrokerWorker.mock.calls[0]?.[0].nativeBuild).toBe(
      values.build,
    );
    await expect(host.runOnce(values.run)).rejects.toMatchObject({
      code: "BROKER_ROLE_PROCESS_ALREADY_USED",
    });
    expect(dependencyMocks.workerRun).toHaveBeenCalledOnce();
  });

  it("rejects another role and a substituted authority pin before worker creation", async () => {
    const values = fixture();
    const other = fixture("second", "second-user");
    const host = createHost(values);

    await expect(host.runOnce(other.run)).rejects.toMatchObject({
      code: "BROKER_ROLE_PROCESS_ENROLLMENT_BINDING",
    });
    await expect(
      host.runOnce({
        ...values.run,
        expectedPreparedOperationAuthoritySha256: sha256("substituted-pin"),
      }),
    ).rejects.toMatchObject({ code: "BROKER_ROLE_PROCESS_AUTHORITY_PIN" });
    expect(host.state()).toBe("ready");
    expect(dependencyMocks.createProbeBrokerWorker).not.toHaveBeenCalled();
    expect(dependencyMocks.observeNativeBrokerStorage).not.toHaveBeenCalled();
  });

  it("rejects an unavailable prepared driver before worker or native I/O", async () => {
    const values = fixture();
    const host = createProbeBrokerRoleProcessHost({
      ...values.hostOptions,
      driverRegistry: [driver("another-driver")],
    });

    await expect(host.runOnce(values.run)).rejects.toMatchObject({
      code: "BROKER_ROLE_PROCESS_UNSUPPORTED_DRIVER",
    });
    expect(host.state()).toBe("ready");
    expect(dependencyMocks.createProbeBrokerWorker).not.toHaveBeenCalled();
    expect(dependencyMocks.observeNativeBrokerStorage).not.toHaveBeenCalled();
  });

  it("does not execute while a role-local storage observation is active", async () => {
    const values = fixture();
    let finishObservation!: () => void;
    const observationGate = new Promise<void>((resolve) => {
      finishObservation = resolve;
    });
    dependencyMocks.observeNativeBrokerStorage.mockImplementation(async () => {
      await observationGate;
      return values.nativeObservationResult;
    });
    const host = createHost(values);
    const observation = host.observeMailbox();
    await vi.waitFor(() => {
      expect(dependencyMocks.observeNativeBrokerStorage).toHaveBeenCalledOnce();
    });

    await expect(host.runOnce(values.run)).rejects.toMatchObject({
      code: "BROKER_ROLE_PROCESS_ALREADY_USED",
    });
    expect(dependencyMocks.createProbeBrokerWorker).not.toHaveBeenCalled();
    finishObservation();
    await expect(observation).resolves.toMatchObject({
      brokerEnrollmentSha256: values.enrollment.brokerEnrollmentSha256,
    });
  });

  it("rejects mutable startup substitutions at construction", () => {
    const values = fixture();
    const wrongStore = fakeStore("E:\\Broker\\other\\mailbox");

    expect(() =>
      createProbeBrokerRoleProcessHost({
        ...values.hostOptions,
        mailboxStore: wrongStore,
      }),
    ).toThrowError(expect.objectContaining({ code: "BROKER_ROLE_PROCESS_MAILBOX_ROOT" }));
    expect(() =>
      createProbeBrokerRoleProcessHost({
        ...values.hostOptions,
        nativeBuild: { ...values.build, taskSha256: sha256("selector") } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "BROKER_ROLE_PROCESS_SCHEMA" }));
    expect(() =>
      createProbeBrokerRoleProcessHost({
        ...values.hostOptions,
        controllerPublicKeyBytes: Buffer.alloc(32),
      }),
    ).toThrowError(expect.objectContaining({ code: "BROKER_ROLE_PROCESS_CONTROLLER_KEY" }));

    const accessorToolchain = Object.create(null);
    Object.defineProperty(accessorToolchain, "compiler", {
      enumerable: true,
      get: () => "substituted-compiler",
    });
    expect(() =>
      createProbeBrokerRoleProcessHost({
        ...values.hostOptions,
        nativeBuild: { ...nativeBuild("accessor"), toolchain: accessorToolchain },
      }),
    ).toThrowError(expect.objectContaining({ code: "BROKER_ROLE_PROCESS_SCHEMA" }));
  });

  it("poisons the entire role process when the worker requires termination", async () => {
    const values = fixture();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const processExitError = Object.assign(new Error("native authority remains live"), {
      code: "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true as const,
    });
    dependencyMocks.workerRun.mockRejectedValue(processExitError);
    const host = createHost(values);
    const alreadyConstructedHost = createHost(fixture("already-constructed"));

    await expect(host.runOnce(values.run)).rejects.toBe(processExitError);
    expect(exit).toHaveBeenCalledWith(70);
    expect(host.state()).toBe("exit-required");
    await expect(host.runOnce(values.run)).rejects.toMatchObject({
      code: "BROKER_ROLE_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
    });
    await expect(alreadyConstructedHost.observeMailbox()).rejects.toMatchObject({
      code: "BROKER_ROLE_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
    });
    await expect(
      alreadyConstructedHost.runOnce(fixture("already-constructed").run),
    ).rejects.toMatchObject({
      code: "BROKER_ROLE_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
    });
    expect(() => createHost(fixture("after-exit"))).toThrowError(
      expect.objectContaining({
        code: "BROKER_ROLE_PROCESS_EXIT_REQUIRED",
        requiresProcessExit: true,
      }),
    );
    expect(dependencyMocks.createProbeBrokerWorker).toHaveBeenCalledOnce();
    expect(dependencyMocks.observeNativeBrokerStorage).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
