import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NATIVE_CLIENT_SOURCE_PATH,
  NATIVE_MANIFEST_DIGEST_SOURCE_PATH,
  PROBE_CONTRACT_SOURCE_PATH,
  PROBE_REGISTRY_SOURCE_PATH,
  PROBE_TRANSCRIPT_SOURCE_PATH,
  createProbeCandidateSourceReaders,
  createProbeEvidenceStoreArtifactReader,
  createProbeFilesystemArtifactReader,
  createProbeFinalizerAdapters,
  createProbePreflightReaders,
  createProbePreparationTransactionReader,
  createProbePreparationTransactionPersistence,
  createProbeRepositoryStateReader,
  readProbeCandidateSourceHashes,
} from "../scripts/windows-host-falsifier/probe-adapters.mjs";
import type {
  ProbeBrokerMailboxObserver,
  ProbeControllerTransport,
  ProbeFinalizerControllerTransport,
  ProbeGuestObserver,
} from "../scripts/windows-host-falsifier/probe-adapters.mjs";
import {
  PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
  PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
  PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { PROBE_BROKER_ROLES } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import { openEvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import { PROBE_CAMPAIGN_MANIFEST_SHA256 } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type {
  ControllerEvidenceSealReceipt,
  NativeEvidenceSeal,
  ProbeFinalizerSealBinding,
} from "../scripts/windows-host-falsifier/probe-finalizer.mjs";
import type {
  ProbeFinalizationIntent,
  ProbeQuiescenceAbandonmentReceipt,
  ProbeQuiescenceCompletionReceipt,
  ProbeQuiescenceLeaseReceipt,
  ProbeSegmentProof,
} from "../scripts/windows-host-falsifier/probe-finalization-lease.mjs";
import {
  derivePreparedProbeContextDigest,
  deriveProbeExecutionBundleManifestDigest,
  deriveProbePreparationClaimReceiptDigest,
  deriveProbePreparationScopeDigest,
  deriveProbePreparationTransactionDigest,
} from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import type {
  ProbeControllerObservation,
  ProbeGuestObservation,
  ProbePreparationTransaction,
  ProbePreflightRequest,
} from "../scripts/windows-host-falsifier/probe-preflight.mjs";

const sentinel = "ENDURAGENT-PROBE-ADAPTER-TEST-SENTINEL";
const repositoryCommit = "c".repeat(40);
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function preparedBrokerEnrollments() {
  return PROBE_BROKER_ROLES.map((brokerRole) => {
    const processSidSha256 =
      brokerRole === "primary-standard-user"
        ? sha256("primary-standard-user")
        : brokerRole === "second-user"
          ? sha256("second-standard-user")
          : sha256(`${brokerRole}:process-sid`);
    const peerAuthoritySha256 = brokerRole === "remote-peer" ? sha256("remote-peer-actor") : null;
    const enrollment = createProbeBrokerEnrollment({
      environmentId: "win11-floor",
      brokerRole,
      brokerInstanceId: `win11-floor-${brokerRole}-broker`,
      mailboxRoot: `E:\\Broker\\win11-floor\\${brokerRole}`,
      mailboxAclSha256: sha256(`${brokerRole}:mailbox-acl`),
      journalRoot: `E:\\BrokerJournal\\win11-floor\\${brokerRole}`,
      journalRootAclSha256: sha256(`${brokerRole}:journal-root-acl`),
      journalDatabaseAclSha256: sha256(`${brokerRole}:journal-database-acl`),
      processSidSha256,
      peerAuthoritySha256,
    });
    return createProbePreparedBrokerEnrollment(enrollment, {
      schemaVersion: 1,
      kind: PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
      brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
      environmentId: enrollment.environmentId,
      brokerRole,
      brokerInstanceId: enrollment.brokerInstanceId,
      mailboxRoot: enrollment.mailboxRoot,
      mailboxSecurityProfile: PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
      mailboxAclSha256: enrollment.mailboxAclSha256,
      mailboxOwnerSidSha256: processSidSha256,
      processSidSha256,
      peerAuthoritySha256,
      mailboxRootObjectIdentitySha256: sha256(`${brokerRole}:mailbox-object`),
      mailboxVolumeIdSha256: sha256(`${brokerRole}:mailbox-volume`),
      mailboxTransportIdentitySha256: sha256(`${brokerRole}:mailbox-transport`),
      mailboxFileSystem: "NTFS",
      mailboxDriveType: "fixed",
      mailboxLocalAbsolute: true,
      mailboxNetworkPath: false,
      mailboxReparsePoint: false,
      journalRoot: enrollment.journalRoot,
      journalSecurityProfile: PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
      journalRootPathSha256: sha256(`${brokerRole}:journal-root-path`),
      journalRootObjectIdentitySha256: sha256(`${brokerRole}:journal-root-object`),
      journalVolumeIdSha256: sha256(`${brokerRole}:journal-volume`),
      journalRootOwnerSidSha256: processSidSha256,
      journalRootAclSha256: enrollment.journalRootAclSha256,
      journalDatabasePathSha256: sha256(`${brokerRole}:journal-database-path`),
      journalDatabaseObjectIdentitySha256: sha256(`${brokerRole}:journal-database-object`),
      journalDatabaseOwnerSidSha256: processSidSha256,
      journalDatabaseAclSha256: enrollment.journalDatabaseAclSha256,
      journalTransportIdentitySha256: sha256(`${brokerRole}:journal-transport`),
      journalFileSystem: "NTFS",
      journalDriveType: "fixed",
      journalLocalAbsolute: true,
      journalNetworkPath: false,
      journalReparsePoint: false,
      bootIdSha256: sha256(`${brokerRole}:boot`),
      runnerSessionIdSha256: sha256(`${brokerRole}:session`),
      nativeHelperSha256: sha256("helper"),
      nativeObservationSha256: sha256(`${brokerRole}:observation`),
    });
  });
}

function preparationTransactionFixture(label = "request"): ProbePreparationTransaction {
  const candidateSha256 = sha256("candidate");
  const labAttestationSha256 = sha256("attestation");
  const lifecyclePolicySha256 = sha256("lifecycle");
  const publicKeySha256 = sha256("controller-key");
  const runPlanSha256 = sha256("run-plan");
  const runAuthorizationSha256 = sha256("run-authorization");
  const runAuthorizationClaimReceiptSha256 = sha256("run-authorization-claim");
  const trustedEvaluationAt = "2026-08-07T00:00:00.000Z";
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
    vm: {
      vmSnapshotId: "floor-snapshot",
      bootIdSha256: sha256("boot"),
      runnerSessionIdSha256: sha256("runner-session"),
    },
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
      identitySha256: sha256("controller"),
      publicKeySha256,
      publicKeyArtifact: { path: "attestations/controller.der", sha256: publicKeySha256 },
      version: "1.0.0",
    },
    actors: {
      primaryStandardUserSidSha256: sha256("primary-standard-user"),
      powerControlActorSha256: sha256("power-control-actor"),
      snapshotControlActorSha256: sha256("snapshot-control-actor"),
      remotePeerActorSha256: sha256("remote-peer-actor"),
      secondUserSidSha256: sha256("second-standard-user"),
    },
    brokerEnrollments: preparedBrokerEnrollments(),
    evidenceArtifacts: [
      { path: "attestations/controller.der", sha256: publicKeySha256 },
      { path: "attestations/controller.json", sha256: sha256("controller-evidence") },
      { path: "attestations/guest.json", sha256: sha256("guest-evidence") },
    ],
    binaries: {
      nativeHelper: {
        path: "bin/helper.exe",
        sha256: sha256("helper"),
        machine: "x64" as const,
        nativeCandidateDigest: sha256("native-candidate"),
        nativeManifestSha256: sha256("native-manifest"),
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
    attemptId: "attempt-ascii",
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
  const preparedContext = {
    ...preparedDraft,
    preflightSha256: derivePreparedProbeContextDigest(preparedDraft),
  };
  const transactionDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-preparation-transaction" as const,
    requestSha256: sha256(label),
    scopeSha256: preparedContext.preparationScopeSha256,
    claimReceiptSha256: preparedContext.preparationClaimReceiptSha256,
    preparedContext,
  };
  return {
    ...transactionDraft,
    transactionSha256: deriveProbePreparationTransactionDigest(transactionDraft),
  } as ProbePreparationTransaction;
}

async function writeFixture(root: string, path: string, value: Uint8Array | string) {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, value);
}

async function repositoryFixture(root: string) {
  const values = new Map<string, Buffer>([
    [PROBE_CONTRACT_SOURCE_PATH, Buffer.from("contract source\n", "utf8")],
    [PROBE_REGISTRY_SOURCE_PATH, Buffer.from("registry source\n", "utf8")],
    [PROBE_TRANSCRIPT_SOURCE_PATH, Buffer.from("transcript source\n", "utf8")],
    [NATIVE_CLIENT_SOURCE_PATH, Buffer.from("native client source\n", "utf8")],
    [NATIVE_MANIFEST_DIGEST_SOURCE_PATH, Buffer.from("native digest source\n", "utf8")],
    [
      "apps/desktop/scripts/windows-host-falsifier/probe-adapters.mjs",
      Buffer.from("adapter source\n", "utf8"),
    ],
  ]);
  for (const [path, bytes] of values) await writeFixture(root, path, bytes);
  const sourceHashes = [...values]
    .map(([path, bytes]) => ({ path, sha256: sha256(bytes) }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return { values, sourceHashes };
}

describe("Windows host production probe adapters", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "enduragent-probe-adapters-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hashes exactly the candidate repository paths and reads live verifier sources", async () => {
    const fixture = await repositoryFixture(root);
    await expect(
      readProbeCandidateSourceHashes({
        repositoryRoot: root,
        sourceHashes: fixture.sourceHashes,
      }),
    ).resolves.toEqual(fixture.sourceHashes);

    const identityRoots: string[] = [];
    const readRepositoryState = await createProbeRepositoryStateReader({
      repositoryRoot: root,
      sourceHashes: fixture.sourceHashes,
      readRepositoryIdentity: async (repositoryRoot) => {
        identityRoots.push(repositoryRoot);
        return { repositoryCommit, repositoryDirty: false };
      },
    });
    await expect(readRepositoryState()).resolves.toEqual({
      repositoryCommit,
      repositoryDirty: false,
      sourceHashes: fixture.sourceHashes,
    });
    expect(identityRoots).toHaveLength(2);

    const readers = await createProbeCandidateSourceReaders({ repositoryRoot: root });
    await expect(readers.readContractSource()).resolves.toEqual(
      fixture.values.get(PROBE_CONTRACT_SOURCE_PATH),
    );
    await expect(readers.readVerifierSource()).resolves.toEqual(
      fixture.values.get(PROBE_REGISTRY_SOURCE_PATH),
    );
    await expect(readers.readTranscriptSource()).resolves.toEqual(
      fixture.values.get(PROBE_TRANSCRIPT_SOURCE_PATH),
    );
    await expect(readers.readNativeClientSource()).resolves.toEqual(
      fixture.values.get(NATIVE_CLIENT_SOURCE_PATH),
    );
    await expect(readers.readNativeManifestDigestSource()).resolves.toEqual(
      fixture.values.get(NATIVE_MANIFEST_DIGEST_SOURCE_PATH),
    );
    const replacement = Buffer.from("changed transcript source\n", "utf8");
    await writeFixture(root, PROBE_TRANSCRIPT_SOURCE_PATH, replacement);
    await expect(readers.readTranscriptSource()).resolves.toEqual(replacement);
  });

  it("rejects escaping, case-colliding, case-mismatched, and linked candidate paths", async () => {
    const digest = "a".repeat(64);
    await expect(
      readProbeCandidateSourceHashes({
        repositoryRoot: root,
        sourceHashes: [{ path: "../outside.mjs", sha256: digest }],
      }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_PATH" });
    await expect(
      readProbeCandidateSourceHashes({
        repositoryRoot: root,
        sourceHashes: [{ path: "C:outside.mjs", sha256: digest }],
      }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_PATH" });
    await expect(
      readProbeCandidateSourceHashes({
        repositoryRoot: root,
        sourceHashes: [
          { path: "Sources/file.mjs", sha256: digest },
          { path: "sources/file.mjs", sha256: digest },
        ],
      }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_CASE_COLLISION" });

    await writeFixture(root, "Sources/Exact.mjs", "exact\n");
    await expect(
      readProbeCandidateSourceHashes({
        repositoryRoot: root,
        sourceHashes: [{ path: "Sources/exact.mjs", sha256: digest }],
      }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_CASE_COLLISION" });

    if (process.platform !== "win32") {
      await writeFixture(root, "Sources/target.mjs", "target\n");
      await symlink(join(root, "Sources", "target.mjs"), join(root, "Sources", "linked.mjs"));
      await expect(
        readProbeCandidateSourceHashes({
          repositoryRoot: root,
          sourceHashes: [{ path: "Sources/linked.mjs", sha256: digest }],
        }),
      ).rejects.toMatchObject({ code: "PROBE_ADAPTER_REPARSE" });
    }
  });

  it("reads retained and filesystem artifacts and recovers only an exact durable claim", async () => {
    const evidenceRoot = join(root, "evidence");
    const binaryRoot = join(root, "binaries");
    await mkdir(evidenceRoot);
    await mkdir(binaryRoot);
    const store = await openEvidenceStore({ root: evidenceRoot, sentinel });
    await store.createDirectory("attestations");
    const retained = await store.writeBytes("attestations/controller.der", "controller-key");
    const retainedReader = createProbeEvidenceStoreArtifactReader({ store });
    await expect(retainedReader(retained)).resolves.toMatchObject({
      ...retained,
      bytes: Buffer.from("controller-key"),
      stableRead: true,
      regularFile: true,
    });
    await expect(retainedReader({ ...retained, sha256: "f".repeat(64) })).rejects.toMatchObject({
      code: "PROBE_ADAPTER_ARTIFACT_DRIFT",
    });

    await writeFixture(binaryRoot, "bin/native-helper.exe", "native-helper");
    const binaryReader = await createProbeFilesystemArtifactReader({ root: binaryRoot });
    await expect(
      binaryReader({
        path: "bin/native-helper.exe",
        sha256: sha256("native-helper"),
      }),
    ).resolves.toMatchObject({ stableRead: true, regularFile: true });

    const persistPreparation = createProbePreparationTransactionPersistence({ store });
    const readPreparationTransaction = createProbePreparationTransactionReader({ store });
    const transaction = preparationTransactionFixture();
    await expect(readPreparationTransaction(transaction.requestSha256)).resolves.toBeNull();
    const first = await persistPreparation(transaction);
    const repeated = await persistPreparation(transaction);
    expect(first).toEqual({ transaction, reused: false });
    expect(repeated).toEqual({ transaction, reused: true });
    await expect(readPreparationTransaction(transaction.requestSha256)).resolves.toEqual(
      transaction,
    );
    await expect(readPreparationTransaction("A".repeat(64))).rejects.toMatchObject({
      code: "PROBE_ADAPTER_SHA256",
    });

    const crashTransaction = preparationTransactionFixture("crash-request");
    let crashed = false;
    const crashingPersistence = createProbePreparationTransactionPersistence({
      store: {
        ...store,
        async writeCanonicalJson(path, value) {
          const artifact = await store.writeCanonicalJson(path, value);
          if (!crashed && path.endsWith(`${crashTransaction.requestSha256}.json`)) {
            crashed = true;
            throw Object.assign(new Error("simulated post-write crash"), {
              code: "SIMULATED_CRASH",
            });
          }
          return artifact;
        },
      },
    });
    await expect(crashingPersistence(crashTransaction)).rejects.toMatchObject({
      code: "SIMULATED_CRASH",
    });
    await expect(persistPreparation(crashTransaction)).resolves.toMatchObject({
      transaction: crashTransaction,
      reused: true,
    });

    const tampered = preparationTransactionFixture("tampered-request");
    await store.writeCanonicalJson(
      `preflight/preparation-transactions/${tampered.requestSha256}.json`,
      { ...tampered, transactionSha256: sha256("tampered") },
    );
    await expect(persistPreparation(tampered)).rejects.toMatchObject({
      code: "PROBE_ADAPTER_PREPARATION_COLLISION",
    });

    const wrongRequestPath = sha256("wrong-request-path");
    await store.writeCanonicalJson(`preflight/preparation-transactions/${wrongRequestPath}.json`, {
      ...transaction,
    });
    await expect(readPreparationTransaction(wrongRequestPath)).rejects.toMatchObject({
      code: "PROBE_ADAPTER_PREPARATION_COLLISION",
    });

    const readFailure = Object.assign(new Error("read denied"), { code: "EACCES" });
    const failingReader = createProbePreparationTransactionReader({
      store: {
        ...store,
        async readArtifact() {
          throw readFailure;
        },
      },
    });
    await expect(failingReader(sha256("read-failure"))).rejects.toBe(readFailure);
  });

  it("delegates controller-only observations and the complete lease lifecycle", async () => {
    const fixture = await repositoryFixture(root);
    const evidenceRoot = join(root, "evidence");
    await mkdir(evidenceRoot);
    const store = await openEvidenceStore({ root: evidenceRoot, sentinel });
    const request = Object.freeze({
      campaignRunId: "campaign",
    }) as unknown as ProbePreflightRequest;
    const guestObservation = Object.freeze({
      environmentId: "win11-floor",
    }) as unknown as ProbeGuestObservation;
    const controllerObservation = Object.freeze({
      identitySha256: "8".repeat(64),
    }) as unknown as ProbeControllerObservation;
    const nativeSeal = Object.freeze({ mode: "exact-paths" }) as unknown as NativeEvidenceSeal;
    const controllerReceipt = Object.freeze({
      kind: "windows-host-probe-controller-evidence-seal-receipt",
    }) as unknown as ControllerEvidenceSealReceipt;
    const finalizationIntent = Object.freeze({
      finalizationOperationSha256: sha256("finalization-operation"),
      evidenceRootObjectIdentitySha256: sha256("evidence-root-object"),
    }) as unknown as ProbeFinalizationIntent;
    const acquisitionReceipt = Object.freeze({
      receiptSha256: sha256("acquisition-receipt"),
      renewalSequence: 0,
    }) as unknown as ProbeQuiescenceLeaseReceipt;
    const captureLeaseReceipt = Object.freeze({
      receiptSha256: sha256("capture-lease-receipt"),
      renewalSequence: 1,
    }) as unknown as ProbeQuiescenceLeaseReceipt;
    const completionLeaseReceipt = Object.freeze({
      receiptSha256: sha256("completion-lease-receipt"),
      renewalSequence: 2,
    }) as unknown as ProbeQuiescenceLeaseReceipt;
    const completionReceipt = Object.freeze({
      receiptSha256: sha256("completion-receipt"),
      state: "completed",
    }) as unknown as ProbeQuiescenceCompletionReceipt;
    const abandonmentReceipt = Object.freeze({
      receiptSha256: sha256("abandonment-receipt"),
      state: "abandoned",
    }) as unknown as ProbeQuiescenceAbandonmentReceipt;
    const segmentProof = Object.freeze({
      segmentPath: "segments/result.json",
      segmentSha256: sha256("segment"),
      segmentArtifactSha256: sha256("segment-artifact"),
      verificationInputSha256: sha256("verification-input"),
      outcomeEvidenceSha256: sha256("outcome-evidence"),
    }) satisfies ProbeSegmentProof;
    const transportCalls: unknown[] = [];
    const controllerTransport: ProbeControllerTransport = {
      observeController: async (input) => {
        transportCalls.push(input);
        return controllerObservation;
      },
      recoverOrAcquireEvidenceQuiescence: async (input) => {
        transportCalls.push(input);
        return {
          acquisitionReceipt,
          leaseReceipt: acquisitionReceipt,
          completionReceipt: null,
        };
      },
      renewEvidenceQuiescence: async (input) => {
        transportCalls.push(input);
        return input.purpose === "capture" ? captureLeaseReceipt : completionLeaseReceipt;
      },
      captureQuiescedEvidenceSeal: async (input) => {
        transportCalls.push(input);
        return { nativeSeal, controllerReceipt };
      },
      completeEvidenceQuiescence: async (input) => {
        transportCalls.push(input);
        return completionReceipt;
      },
      abandonEvidenceQuiescence: async (input) => {
        transportCalls.push(input);
        return abandonmentReceipt;
      },
    };
    const guestCalls: unknown[] = [];
    const brokerCalls: unknown[] = [];
    const observeGuest: ProbeGuestObserver = async (input) => {
      guestCalls.push(input);
      return guestObservation;
    };
    const observeBrokerMailbox: ProbeBrokerMailboxObserver = async (input) => {
      brokerCalls.push(input);
      return {} as never;
    };
    const candidate = { sourceHashes: fixture.sourceHashes };
    const identity = async () => ({ repositoryCommit, repositoryDirty: false });
    const preflightReaders = await createProbePreflightReaders({
      store,
      repositoryRoot: root,
      binaryRoot: root,
      candidate,
      observeGuest,
      observeBrokerMailbox,
      controllerTransport,
      readRepositoryIdentity: identity,
    });
    await expect(preflightReaders.observeGuest(request)).resolves.toBe(guestObservation);
    await expect(preflightReaders.observeController(request)).resolves.toBe(controllerObservation);
    const enrollment = createProbeBrokerEnrollment({
      environmentId: "win11-floor",
      brokerRole: "primary-standard-user",
      brokerInstanceId: "win11-floor-primary-standard-user-broker",
      mailboxRoot: "E:\\Broker\\win11-floor\\primary-standard-user",
      mailboxAclSha256: sha256("primary-mailbox-acl"),
      journalRoot: "E:\\BrokerJournal\\win11-floor\\primary-standard-user",
      journalRootAclSha256: sha256("primary-journal-root-acl"),
      journalDatabaseAclSha256: sha256("primary-journal-database-acl"),
      processSidSha256: sha256("primary-process-sid"),
      peerAuthoritySha256: null,
    });
    await expect(preflightReaders.observeBrokerMailbox(enrollment, request)).resolves.toEqual({});
    await expect(
      preflightReaders.readPreparationTransaction(sha256("missing-preparation")),
    ).resolves.toBeNull();
    expect(guestCalls).toEqual([{ request, evidenceRoot: store.root }]);
    expect(brokerCalls).toEqual([{ enrollment, request, evidenceRoot: store.root }]);
    expect(transportCalls).toEqual([{ request, evidenceRoot: store.root }]);

    const now = () => new Date("2026-08-07T00:00:00.000Z");
    const monotonicNow = () => 42;
    const finalizerAdapters = await createProbeFinalizerAdapters({
      store,
      repositoryRoot: root,
      candidate,
      controllerTransport,
      readRepositoryIdentity: identity,
      now,
      monotonicNow,
    });
    const binding = Object.freeze({
      finalizationIntent,
      quiescenceLease: captureLeaseReceipt,
      campaignId: "f01-f10-native-probe-v1",
      manifestSha256: sha256("manifest"),
      candidateSha256: sha256("candidate"),
      campaignRunId: "campaign-one",
      executionRunId: "execution-one",
      executionBundleId: "bundle-one",
      executionBundleManifestSha256: sha256("bundle"),
      attemptId: "attempt-one",
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      rowId: "F01",
      variantId: "F01-baseline",
      exactArtifactPaths: ["segments/facts.json"],
    }) satisfies ProbeFinalizerSealBinding;
    await expect(
      finalizerAdapters.recoverOrAcquireEvidenceQuiescence({ finalizationIntent }),
    ).resolves.toEqual({
      acquisitionReceipt,
      leaseReceipt: acquisitionReceipt,
      completionReceipt: null,
    });
    expect(transportCalls.at(-1)).toEqual({ finalizationIntent, evidenceRoot: store.root });
    await expect(
      finalizerAdapters.renewEvidenceQuiescence({
        finalizationIntent,
        previousLeaseReceipt: acquisitionReceipt,
        purpose: "capture",
      }),
    ).resolves.toBe(captureLeaseReceipt);
    expect(transportCalls.at(-1)).toEqual({
      finalizationIntent,
      previousLeaseReceipt: acquisitionReceipt,
      purpose: "capture",
      evidenceRoot: store.root,
    });
    await expect(finalizerAdapters.captureQuiescedEvidenceSeal(binding)).resolves.toEqual({
      nativeSeal,
      controllerReceipt,
    });
    expect(transportCalls.at(-1)).toEqual({ binding, evidenceRoot: store.root });
    await expect(
      finalizerAdapters.completeEvidenceQuiescence({
        finalizationIntent,
        leaseReceipt: completionLeaseReceipt,
        evidenceCaptureReceiptSha256: controllerReceipt.receiptSha256 ?? sha256("capture"),
        segmentProof,
      }),
    ).resolves.toBe(completionReceipt);
    expect(transportCalls.at(-1)).toEqual({
      finalizationIntent,
      leaseReceipt: completionLeaseReceipt,
      evidenceCaptureReceiptSha256: controllerReceipt.receiptSha256 ?? sha256("capture"),
      segmentProof,
      evidenceRoot: store.root,
    });
    await expect(
      finalizerAdapters.abandonEvidenceQuiescence({
        finalizationIntent,
        leaseReceipt: captureLeaseReceipt,
        reasonCode: "FINALIZATION_FAILED",
      }),
    ).resolves.toBe(abandonmentReceipt);
    expect(transportCalls.at(-1)).toEqual({
      finalizationIntent,
      leaseReceipt: captureLeaseReceipt,
      reasonCode: "FINALIZATION_FAILED",
      evidenceRoot: store.root,
    });
    expect(finalizerAdapters.now()).toEqual(now());
    expect(finalizerAdapters.monotonicNow()).toBe(42);
    await expect(finalizerAdapters.readContractSource()).resolves.toEqual(
      fixture.values.get(PROBE_CONTRACT_SOURCE_PATH),
    );
    await expect(finalizerAdapters.readNativeManifestDigestSource()).resolves.toEqual(
      fixture.values.get(NATIVE_MANIFEST_DIGEST_SOURCE_PATH),
    );
  });

  it("fails closed on incomplete transports, extra authority inputs, and malformed replies", async () => {
    const fixture = await repositoryFixture(root);
    const evidenceRoot = join(root, "evidence");
    await mkdir(evidenceRoot);
    const store = await openEvidenceStore({ root: evidenceRoot, sentinel });
    const candidate = { sourceHashes: fixture.sourceHashes };
    const identity = async () => ({ repositoryCommit, repositoryDirty: false });
    const finalizationIntent = Object.freeze({
      finalizationOperationSha256: sha256("finalization-operation"),
    }) as unknown as ProbeFinalizationIntent;
    const leaseReceipt = Object.freeze({
      receiptSha256: sha256("lease-receipt"),
    }) as unknown as ProbeQuiescenceLeaseReceipt;
    const completionReceipt = Object.freeze({
      receiptSha256: sha256("completion-receipt"),
    }) as unknown as ProbeQuiescenceCompletionReceipt;
    const abandonmentReceipt = Object.freeze({
      receiptSha256: sha256("abandonment-receipt"),
    }) as unknown as ProbeQuiescenceAbandonmentReceipt;
    const nativeSeal = Object.freeze({ mode: "exact-paths" }) as unknown as NativeEvidenceSeal;
    const controllerReceipt = Object.freeze({
      receiptSha256: sha256("capture-receipt"),
    }) as unknown as ControllerEvidenceSealReceipt;
    let recoveryCalls = 0;
    let abandonmentCalls = 0;
    const transport: ProbeFinalizerControllerTransport = {
      recoverOrAcquireEvidenceQuiescence: async () => {
        recoveryCalls += 1;
        return { acquisitionReceipt: leaseReceipt, leaseReceipt, completionReceipt: null };
      },
      renewEvidenceQuiescence: async () => leaseReceipt,
      captureQuiescedEvidenceSeal: async () => ({ nativeSeal, controllerReceipt }),
      completeEvidenceQuiescence: async () => completionReceipt,
      abandonEvidenceQuiescence: async () => {
        abandonmentCalls += 1;
        return abandonmentReceipt;
      },
    };

    await expect(
      createProbeFinalizerAdapters({
        store,
        repositoryRoot: root,
        candidate,
        controllerTransport: {
          ...transport,
          renewEvidenceQuiescence: undefined,
        } as unknown as ProbeFinalizerControllerTransport,
        readRepositoryIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_CONTROLLER" });

    const adapters = await createProbeFinalizerAdapters({
      store,
      repositoryRoot: root,
      candidate,
      controllerTransport: transport,
      readRepositoryIdentity: identity,
    });
    await expect(
      adapters.abandonEvidenceQuiescence({
        finalizationIntent,
        leaseReceipt,
        reasonCode: "FAILED",
        trustStore: Object.freeze({}),
      } as unknown as Parameters<typeof adapters.abandonEvidenceQuiescence>[0]),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_SCHEMA" });
    expect(abandonmentCalls).toBe(0);

    const malformedReplyAdapters = await createProbeFinalizerAdapters({
      store,
      repositoryRoot: root,
      candidate,
      controllerTransport: {
        ...transport,
        recoverOrAcquireEvidenceQuiescence: async () => {
          recoveryCalls += 1;
          return {
            acquisitionReceipt: leaseReceipt,
            leaseReceipt,
            completionReceipt: null,
            controllerPrivateKey: "forbidden",
          } as unknown as Awaited<
            ReturnType<ProbeFinalizerControllerTransport["recoverOrAcquireEvidenceQuiescence"]>
          >;
        },
      },
      readRepositoryIdentity: identity,
    });
    await expect(
      malformedReplyAdapters.recoverOrAcquireEvidenceQuiescence({ finalizationIntent }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_SCHEMA" });
    expect(recoveryCalls).toBe(1);
  });

  it("records and passes the executable target explicitly to the native compiler", async () => {
    const compileScript = await readFile(
      new URL("../scripts/windows-host-falsifier/native/compile.ps1", import.meta.url),
      "utf8",
    );
    expect(compileScript).toContain(
      "$compilerOptions = '/target:exe /platform:x64 /checked+ /optimize+ /warn:4 /nologo'",
    );
    expect(compileScript).toContain(
      'CompilerOptions="/target:exe /platform:x64 /checked+ /optimize+ /warn:4 /nologo"',
    );
    expect(compileScript).toContain("$compilerParameters.GenerateExecutable = $true");
  });
});
