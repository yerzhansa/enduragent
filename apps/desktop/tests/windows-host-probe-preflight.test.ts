import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
  PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
  PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
  createProbeBrokerEnrollment,
  type ProbeBrokerMailboxObservation,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { PROBE_BROKER_ROLES } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  PROBE_CAMPAIGN_MANIFEST,
  PROBE_ENVIRONMENT_IDS,
  deriveCandidateDigest,
  deriveLabAttestationDigest,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type {
  ProbeCandidateDigestFields,
  ProbeCandidateIdentity,
  ProbeLabAttestation,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import {
  deriveProbeExecutionBundleManifestDigest,
  deriveProbePreparationTransactionDigest,
  prepareAuthoritativeProbeContext,
  validatePreparedProbeContext,
} from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import {
  deriveProbeOperatorTrustStoreDigest,
  deriveProbeRunAuthorizationClaimReceiptDigest,
  deriveProbeRunAuthorizationDigest,
  type ProbeRunAuthorization,
  type ProbeRunAuthorizationClaimReceipt,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import type {
  ProbeControllerObservation,
  ProbeGuestObservation,
  ProbeLifecyclePolicy,
  ProbePreparationTransaction,
  ProbePreflightReaders,
  ProbePreflightRequest,
  ProbeRepositoryState,
  ProbeVerifiedArtifact,
} from "../scripts/windows-host-falsifier/probe-preflight.mjs";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (label: string) => hashProbeCanonicalJson({ label });

function amd64Pe(): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(0x8664, 68);
  return bytes;
}

function setup({ helperBytes = amd64Pe() }: { helperBytes?: Buffer } = {}) {
  const nsisBytes = Buffer.from("synthetic pinned NSIS executable", "utf8");
  const asciiGuestEvidenceBytes = Buffer.from("sanitized ascii guest evidence", "utf8");
  const unicodeGuestEvidenceBytes = Buffer.from("sanitized unicode guest evidence", "utf8");
  const controllerEvidenceBytes = Buffer.from("sanitized controller evidence", "utf8");
  const controllerPair = generateKeyPairSync("ed25519");
  const publicKeyBytes = controllerPair.publicKey.export({ format: "der", type: "spki" });
  const powerShellExecutableSha256 = digest("windows-powershell-executable");

  const candidateFields: ProbeCandidateDigestFields = {
    schemaVersion: 1,
    kind: "windows-host-probe-candidate",
    repositoryCommit: "c".repeat(40),
    sourceHashes: [
      { path: "probe/native-helper.cs", sha256: digest("native-helper-source") },
      { path: "probe/runner.mjs", sha256: digest("runner-source") },
    ],
    binaryHashes: [
      { path: "bin/native-helper.exe", sha256: sha256(helperBytes) },
      { path: "toolchain/nsis.exe", sha256: sha256(nsisBytes) },
    ],
    compiler: {
      provider: "Microsoft.CSharp.CSharpCodeProvider",
      codeDomProviderAssemblyVersion: "4.0.0.0",
      cscFileVersion: "4.8.9256.0",
      cscSha256: digest("csc-executable"),
      outputType: "ConsoleApplication",
      platform: "x64",
    },
    toolchain: {
      nodeVersion: "24.5.0",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      powerShellVersion: "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256,
      clrVersion: "v4.0.30319",
      runtimeDirectorySha256Before: digest("runtime-directory"),
      runtimeDirectorySha256After: digest("runtime-directory"),
      runtimeRelativeInventory: [
        "System.Core.dll",
        "System.Security.dll",
        "System.Web.Extensions.dll",
        "System.dll",
        "csc.exe",
      ],
    },
    buildFlags: ["/debug-", "/optimize+", "/platform:x64", "/target:exe"],
    referencedAssemblies: ["System.Core.dll", "System.dll"],
    configurationSha256: digest("candidate-configuration"),
  };
  const candidate: ProbeCandidateIdentity = {
    ...candidateFields,
    candidateSha256: deriveCandidateDigest(candidateFields),
  };

  const attestationFields: Omit<ProbeLabAttestation, "attestationSha256"> = {
    schemaVersion: 1,
    kind: "sanitized-windows-11-lab-attestation",
    environmentId: "win11-floor",
    sanitized: true,
    host: {
      windowsEdition: "Windows 11 Pro",
      osCaption: "Microsoft Windows 11 Pro",
      windowsVersion: "24H2",
      osBuild: "26100",
      patchLevel: "synthetic-preflight-fixture",
      productType: "workstation",
      machineArchitecture: "x64",
      processArchitecture: "x64",
      systemVolumeFileSystem: "NTFS",
      systemVolumeIdSha256: digest("system-volume"),
      testVolumeFileSystem: "NTFS",
      testVolumeIdSha256: digest("test-volume"),
      standardUserSidSha256: digest("standard-user"),
      elevated: false,
      defenderRealtimeEnabled: true,
      uacDefault: true,
      developerModeEnabled: false,
    },
    snapshot: {
      vmImageId: "win11-floor-image",
      vmImageSha256: digest("floor-image"),
      vmSnapshotId: "win11-floor-clean-snapshot",
      cleanImageVersion: "2026.08.06.1",
    },
    runner: {
      version: "2.327.1",
      labels: [
        "enduragent-falsifier",
        "self-hosted",
        "win11-floor",
        "windows",
        "windows-11",
        "x64",
      ],
      interactiveSessionOwnerSidSha256: digest("standard-user"),
    },
    runtime: {
      nodeVersion: "24.5.0",
      powerShellVersion: "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256,
      clrVersion: "v4.0.30319",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      nsisExecutableSha256: sha256(nsisBytes),
    },
    controller: {
      identitySha256: digest("controller-identity"),
      publicKeySha256: sha256(publicKeyBytes),
      publicKeyArtifact: {
        path: "attestations/controller-public-key.spki.der",
        sha256: sha256(publicKeyBytes),
      },
      version: "1.2.3",
    },
    capabilities: {
      bootCompleteObservation: true,
      defaultUac: true,
      defenderRealtimeEnabled: true,
      developerModeDisabled: true,
      externalAbruptPower: true,
      externalSnapshotRestore: true,
      immutableSnapshotIdentity: true,
      interactiveStandardUserSession: true,
      isolatedNatAndHostOnlyNetwork: true,
      nativeWindows11X64: true,
      ntfsSystemAndTestVolumes: true,
      remoteWindowsPeer: true,
      runnerIdentityPinned: true,
      secondStandardUser: true,
      standardUserNonElevated: true,
    },
    guestEvidenceByPathProfile: [
      {
        pathProfileId: "ascii",
        artifact: {
          path: "attestations/win11-floor-ascii-guest.json",
          sha256: sha256(asciiGuestEvidenceBytes),
        },
      },
      {
        pathProfileId: "spaces-unicode",
        artifact: {
          path: "attestations/win11-floor-spaces-unicode-guest.json",
          sha256: sha256(unicodeGuestEvidenceBytes),
        },
      },
    ],
    controllerEvidence: {
      path: "attestations/win11-floor-controller.json",
      sha256: sha256(controllerEvidenceBytes),
    },
  };
  const attestation: ProbeLabAttestation = {
    ...attestationFields,
    attestationSha256: deriveLabAttestationDigest(attestationFields),
  };
  const operatorPair = generateKeyPairSync("ed25519");
  const operatorPublicKeyBytes = operatorPair.publicKey.export({ format: "der", type: "spki" });
  const trustStoreDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-operator-trust-store" as const,
    trustStoreId: "windows-lab-operators",
    generation: 1,
    keys: [
      {
        operatorKeyId: "operator-01",
        publicKeySpkiBase64: operatorPublicKeyBytes.toString("base64"),
        publicKeySha256: sha256(operatorPublicKeyBytes),
        status: "active" as const,
      },
    ],
  };
  const trustStoreSha256 = deriveProbeOperatorTrustStoreDigest(trustStoreDraft);
  const runAuthorizationDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: hashProbeCanonicalJson(PROBE_CAMPAIGN_MANIFEST),
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: candidate.candidateSha256,
    campaignRunId: "campaign-run-one",
    attestations: [
      { environmentId: "win11-current" as const, attestationSha256: digest("current-attestation") },
      { environmentId: "win11-floor" as const, attestationSha256: attestation.attestationSha256 },
    ],
    issuedAt: "2026-08-06T09:00:00.000Z",
    expiresAt: "2026-08-06T11:00:00.000Z",
    operatorKeyId: "operator-01",
    trustStoreId: "windows-lab-operators",
    trustStoreGeneration: 1,
    signatureAlgorithm: "Ed25519" as const,
  };
  const authorizationSha256 = deriveProbeRunAuthorizationDigest(runAuthorizationDraft);
  const runAuthorization: ProbeRunAuthorization = {
    ...runAuthorizationDraft,
    authorizationSha256,
    signatureBase64: sign(
      null,
      Buffer.from(authorizationSha256, "hex"),
      operatorPair.privateKey,
    ).toString("base64"),
  };

  const request: ProbePreflightRequest = {
    campaignRunId: "campaign-run-one",
    executionRunId: "execution-win11-floor",
    executionBundleId: "bundle-win11-floor",
    attemptId: "attempt-ascii",
    environmentId: "win11-floor",
    pathProfileId: "ascii",
    vmSnapshotId: attestation.snapshot.vmSnapshotId,
    bootIdSha256: digest("floor-boot"),
    runnerSessionIdSha256: digest("floor-runner-session"),
    nativeHelperArtifactPath: "bin/native-helper.exe",
    nativeCandidateDigest: digest("native-candidate"),
    nativeManifestSha256: digest("native-manifest"),
    nsisArtifactPath: "toolchain/nsis.exe",
  };
  const lifecyclePolicy: ProbeLifecyclePolicy = {
    policyId: "windows-client-lifecycle-2026-08",
    evaluatedAt: "2026-08-06T10:00:00.000Z",
    mappings: [
      {
        environmentId: "win11-floor",
        role: "floor",
        windowsVersion: "24H2",
        minimumBuild: 26_100,
        maximumBuild: 26_199,
        supportedFrom: "2024-10-01T00:00:00.000Z",
        supportedUntil: "2026-10-01T00:00:00.000Z",
        declaredSupported: true,
      },
      {
        environmentId: "win11-current",
        role: "current",
        windowsVersion: "25H2",
        minimumBuild: 26_200,
        maximumBuild: null,
        supportedFrom: "2025-10-01T00:00:00.000Z",
        supportedUntil: "2027-10-01T00:00:00.000Z",
        declaredSupported: true,
      },
    ],
  };
  const repositoryState: ProbeRepositoryState = {
    repositoryCommit: candidate.repositoryCommit,
    repositoryDirty: false,
    sourceHashes: candidate.sourceHashes,
  };
  const guestObservation: ProbeGuestObservation = {
    environmentId: request.environmentId,
    pathProfileId: request.pathProfileId,
    host: attestation.host,
    snapshot: attestation.snapshot,
    runner: attestation.runner,
    runtime: attestation.runtime,
    bootIdSha256: request.bootIdSha256,
    runnerSessionIdSha256: request.runnerSessionIdSha256,
    pathProfile: {
      profileId: "ascii",
      rootPathSha256: digest("ascii-root-path"),
      evidenceRootObjectIdentitySha256: digest("ascii-evidence-root-object-identity"),
      volumeIdSha256: attestation.host.testVolumeIdSha256,
      localAbsolute: true,
      networkPath: false,
      removableVolume: false,
      reparsePoint: false,
      nfcNormalized: true,
      containsSpaces: false,
      containsUnicode: false,
    },
    guestEvidence: attestation.guestEvidenceByPathProfile[0].artifact,
  };
  const controllerObservation: ProbeControllerObservation = {
    identitySha256: attestation.controller.identitySha256,
    publicKeySha256: attestation.controller.publicKeySha256,
    version: attestation.controller.version,
    vmSnapshotId: request.vmSnapshotId,
    bootIdSha256: request.bootIdSha256,
    runnerSessionIdSha256: request.runnerSessionIdSha256,
    capabilities: attestation.capabilities,
    actors: {
      powerControlActorSha256: digest("power-actor"),
      snapshotControlActorSha256: digest("snapshot-actor"),
      remotePeerActorSha256: digest("peer-actor"),
      secondUserSidSha256: digest("second-user"),
    },
    controllerEvidence: attestation.controllerEvidence,
    publicKeyArtifact: attestation.controller.publicKeyArtifact,
  };
  const brokerEnrollments = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
    PROBE_BROKER_ROLES.map((brokerRole) => {
      const isPreparedEnvironment = environmentId === request.environmentId;
      const processSidSha256 =
        brokerRole === "primary-standard-user"
          ? isPreparedEnvironment
            ? guestObservation.host.standardUserSidSha256
            : digest(`${environmentId}-primary-standard-user`)
          : brokerRole === "second-user"
            ? isPreparedEnvironment
              ? controllerObservation.actors.secondUserSidSha256
              : digest(`${environmentId}-second-user`)
            : digest(`${environmentId}-remote-peer-process-sid`);
      return createProbeBrokerEnrollment({
        environmentId,
        brokerRole,
        brokerInstanceId: `${environmentId}-${brokerRole}-broker`,
        mailboxRoot: `E:\\Broker\\${environmentId}\\${brokerRole}`,
        mailboxAclSha256: digest(`${environmentId}-${brokerRole}-mailbox-acl`),
        journalRoot: `E:\\BrokerJournal\\${environmentId}\\${brokerRole}`,
        journalRootAclSha256: digest(`${environmentId}-${brokerRole}-journal-root-acl`),
        journalDatabaseAclSha256: digest(`${environmentId}-${brokerRole}-journal-database-acl`),
        processSidSha256,
        peerAuthoritySha256:
          brokerRole === "remote-peer"
            ? isPreparedEnvironment
              ? controllerObservation.actors.remotePeerActorSha256
              : digest(`${environmentId}-remote-peer-authority`)
            : null,
      });
    }),
  );
  const brokerMailboxObservations = new Map<string, ProbeBrokerMailboxObservation>(
    brokerEnrollments
      .filter((entry) => entry.environmentId === request.environmentId)
      .map((enrollment) => [
        enrollment.brokerEnrollmentSha256,
        {
          schemaVersion: 1,
          kind: PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
          brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
          environmentId: enrollment.environmentId,
          brokerRole: enrollment.brokerRole,
          brokerInstanceId: enrollment.brokerInstanceId,
          mailboxRoot: enrollment.mailboxRoot,
          mailboxSecurityProfile: PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
          mailboxAclSha256: enrollment.mailboxAclSha256,
          mailboxOwnerSidSha256: enrollment.processSidSha256,
          processSidSha256: enrollment.processSidSha256,
          peerAuthoritySha256: enrollment.peerAuthoritySha256,
          mailboxRootObjectIdentitySha256: digest(`${enrollment.brokerInstanceId}-mailbox-object`),
          mailboxVolumeIdSha256: digest(`${enrollment.brokerInstanceId}-mailbox-volume`),
          mailboxTransportIdentitySha256: digest(
            `${enrollment.brokerInstanceId}-mailbox-transport`,
          ),
          mailboxFileSystem: "NTFS",
          mailboxDriveType: "fixed",
          mailboxLocalAbsolute: true,
          mailboxNetworkPath: false,
          mailboxReparsePoint: false,
          journalRoot: enrollment.journalRoot,
          journalSecurityProfile: PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
          journalRootPathSha256: digest(`${enrollment.brokerInstanceId}-journal-root-path`),
          journalRootObjectIdentitySha256: digest(
            `${enrollment.brokerInstanceId}-journal-root-object`,
          ),
          journalVolumeIdSha256: digest(`${enrollment.brokerInstanceId}-journal-volume`),
          journalRootOwnerSidSha256: enrollment.processSidSha256,
          journalRootAclSha256: enrollment.journalRootAclSha256,
          journalDatabasePathSha256: digest(`${enrollment.brokerInstanceId}-journal-database-path`),
          journalDatabaseObjectIdentitySha256: digest(
            `${enrollment.brokerInstanceId}-journal-database-object`,
          ),
          journalDatabaseOwnerSidSha256: enrollment.processSidSha256,
          journalDatabaseAclSha256: enrollment.journalDatabaseAclSha256,
          journalTransportIdentitySha256: digest(
            `${enrollment.brokerInstanceId}-journal-transport`,
          ),
          journalFileSystem: "NTFS",
          journalDriveType: "fixed",
          journalLocalAbsolute: true,
          journalNetworkPath: false,
          journalReparsePoint: false,
          bootIdSha256:
            enrollment.brokerRole === "remote-peer"
              ? digest("remote-peer-boot")
              : request.bootIdSha256,
          runnerSessionIdSha256:
            enrollment.brokerRole === "primary-standard-user"
              ? request.runnerSessionIdSha256
              : digest(`${enrollment.brokerRole}-runner-session`),
          nativeHelperSha256: sha256(helperBytes),
          nativeObservationSha256: digest(`${enrollment.brokerInstanceId}-native-observation`),
        },
      ]),
  );
  const createRunAuthorizationClaim = (
    evidenceRootObjectIdentitySha256: string,
  ): ProbeRunAuthorizationClaimReceipt => {
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-run-authorization-claim-receipt" as const,
      campaignId: runAuthorization.campaignId,
      manifestSha256: runAuthorization.manifestSha256,
      runPlanSha256: runAuthorization.runPlanSha256,
      candidateSha256: runAuthorization.candidateSha256,
      campaignRunId: runAuthorization.campaignRunId,
      environmentId: attestation.environmentId,
      labAttestationSha256: attestation.attestationSha256,
      evidenceRootObjectIdentitySha256,
      authorizationSha256: runAuthorization.authorizationSha256,
      operatorKeyId: runAuthorization.operatorKeyId,
      operatorPublicKeySha256: sha256(operatorPublicKeyBytes),
      trustStoreId: runAuthorization.trustStoreId,
      trustStoreGeneration: runAuthorization.trustStoreGeneration,
      trustStoreSha256,
      verifiedAt: "2026-08-06T09:59:00.000Z",
      authorizationExpiresAt: runAuthorization.expiresAt,
      controllerIdentitySha256: attestation.controller.identitySha256,
      controllerPublicKeySha256: attestation.controller.publicKeySha256,
      controllerVersion: attestation.controller.version,
      signatureAlgorithm: "Ed25519" as const,
    };
    const receiptSha256 = deriveProbeRunAuthorizationClaimReceiptDigest(unsigned);
    return {
      ...unsigned,
      receiptSha256,
      signatureBase64: sign(
        null,
        Buffer.from(receiptSha256, "hex"),
        controllerPair.privateKey,
      ).toString("base64"),
    };
  };
  const runAuthorizationClaim = createRunAuthorizationClaim(
    guestObservation.pathProfile.evidenceRootObjectIdentitySha256,
  );
  const artifactBytes = new Map<string, Uint8Array>([
    [attestation.guestEvidenceByPathProfile[0].artifact.path, asciiGuestEvidenceBytes],
    [attestation.guestEvidenceByPathProfile[1].artifact.path, unicodeGuestEvidenceBytes],
    [attestation.controllerEvidence.path, controllerEvidenceBytes],
    [attestation.controller.publicKeyArtifact.path, publicKeyBytes],
    [request.nativeHelperArtifactPath, helperBytes],
    [request.nsisArtifactPath, nsisBytes],
  ]);
  const events: string[] = [];
  const retainedPreparationTransactions = new Map<string, ProbePreparationTransaction>();
  const state = { repositoryState, guestObservation, controllerObservation };
  const readArtifact = async (reference: { path: string; sha256: string }) => {
    events.push(`read:${reference.path}`);
    const bytes = artifactBytes.get(reference.path);
    if (bytes === undefined) throw new Error(`missing fixture artifact ${reference.path}`);
    return {
      path: reference.path,
      sha256: sha256(bytes),
      bytes,
      stableRead: true as const,
      regularFile: true as const,
    } satisfies ProbeVerifiedArtifact;
  };
  const readers: ProbePreflightReaders = {
    readPreparationTransaction: async (requestSha256) => {
      events.push("read-preparation");
      return retainedPreparationTransactions.get(requestSha256) ?? null;
    },
    readRepositoryState: async () => {
      events.push("repository");
      return state.repositoryState;
    },
    observeGuest: async () => {
      events.push("guest");
      return state.guestObservation;
    },
    observeController: async () => {
      events.push("controller");
      return state.controllerObservation;
    },
    observeBrokerMailbox: async (enrollment) => {
      events.push(`broker-mailbox:${enrollment.brokerRole}`);
      const observation = brokerMailboxObservations.get(enrollment.brokerEnrollmentSha256);
      if (observation === undefined) throw new Error("missing broker mailbox observation");
      return observation;
    },
    readVerifiedEvidenceArtifact: readArtifact,
    readVerifiedBinaryArtifact: readArtifact,
    persistPreparation: async (transaction) => {
      events.push("persist");
      const retained = retainedPreparationTransactions.get(transaction.requestSha256);
      if (retained === undefined) {
        retainedPreparationTransactions.set(transaction.requestSha256, transaction);
        return { transaction, reused: false };
      }
      return { transaction: retained, reused: true };
    },
  };
  return {
    candidate,
    attestation,
    runAuthorization,
    runAuthorizationClaim,
    createRunAuthorizationClaim,
    request,
    lifecyclePolicy,
    repositoryState,
    guestObservation,
    controllerObservation,
    brokerEnrollments,
    brokerMailboxObservations,
    readers,
    state,
    events,
  };
}

async function prepare(fixture: ReturnType<typeof setup>, timestamp = "2026-08-06T10:00:00.000Z") {
  return prepareAuthoritativeProbeContext({
    manifest: PROBE_CAMPAIGN_MANIFEST,
    candidate: fixture.candidate,
    attestation: fixture.attestation,
    runAuthorization: fixture.runAuthorization,
    runAuthorizationClaim: fixture.runAuthorizationClaim,
    request: fixture.request,
    lifecyclePolicy: fixture.lifecyclePolicy,
    brokerEnrollments: fixture.brokerEnrollments,
    readers: fixture.readers,
    now: () => new Date(timestamp),
  });
}

describe("Windows host authoritative probe preflight", () => {
  it("returns one immutable, authority-free execution context after every fact is verified", async () => {
    const fixture = setup();
    const context = await prepare(fixture);

    expect(validatePreparedProbeContext(context)).toEqual(context);
    expect(context).toMatchObject({
      campaignRunId: fixture.request.campaignRunId,
      executionRunId: fixture.request.executionRunId,
      executionBundleId: fixture.request.executionBundleId,
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      controllerPublicKeyArtifact: fixture.attestation.controller.publicKeyArtifact,
    });
    expect(context.executionBundleManifest.executionBundleManifestSha256).toBe(
      context.executionBundleManifestSha256,
    );
    expect(context.executionBundleManifest.binaries.nativeHelper).toMatchObject({
      nativeCandidateDigest: fixture.request.nativeCandidateDigest,
      nativeManifestSha256: fixture.request.nativeManifestSha256,
    });
    expect(context.executionBundleManifest.actors).toEqual({
      primaryStandardUserSidSha256: fixture.guestObservation.host.standardUserSidSha256,
      ...fixture.controllerObservation.actors,
    });
    expect(
      context.executionBundleManifest.brokerEnrollments.map((entry) => entry.brokerRole),
    ).toEqual(PROBE_BROKER_ROLES);
    expect(context.executionBundleManifest.brokerEnrollments).toHaveLength(3);
    expect(context.executionBundleManifest.brokerEnrollments[0]).toMatchObject({
      processSidSha256: fixture.guestObservation.host.standardUserSidSha256,
      bootIdSha256: fixture.request.bootIdSha256,
      runnerSessionIdSha256: fixture.request.runnerSessionIdSha256,
    });
    expect(context.executionBundleManifest.brokerEnrollments[1].processSidSha256).toBe(
      fixture.controllerObservation.actors.secondUserSidSha256,
    );
    expect(context.executionBundleManifest.brokerEnrollments[2]).toMatchObject({
      peerAuthoritySha256: fixture.controllerObservation.actors.remotePeerActorSha256,
    });
    expect(context.executionBundleManifest.evidenceArtifacts).toContainEqual(
      fixture.attestation.guestEvidenceByPathProfile[0].artifact,
    );
    expect(context.executionBundleManifest.evidenceArtifacts).not.toContainEqual(
      fixture.attestation.guestEvidenceByPathProfile[1].artifact,
    );
    expect(fixture.events).toContain(
      `read:${fixture.attestation.guestEvidenceByPathProfile[0].artifact.path}`,
    );
    expect(fixture.events).not.toContain(
      `read:${fixture.attestation.guestEvidenceByPathProfile[1].artifact.path}`,
    );
    expect(JSON.stringify(context)).not.toMatch(
      /"(?:outcome|rowId|selectedMechanism|selectionDigest|status|variantId)"/u,
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.executionBundleManifest.runtime)).toBe(true);
    expect(Object.isFrozen(context.executionBundleManifest.actors)).toBe(true);
    expect(Object.isFrozen(context.executionBundleManifest.brokerEnrollments[0])).toBe(true);
    expect(fixture.events.at(-1)).toBe("persist");
  });

  it("fails closed on incomplete enrollment authority or mailbox/native observation drift", async () => {
    const incomplete = setup();
    incomplete.brokerEnrollments = incomplete.brokerEnrollments.slice(0, -1);
    await expect(prepare(incomplete)).rejects.toThrow(/every environment and role/u);
    expect(incomplete.events).toEqual([]);

    const aclDrift = setup();
    const observeAcl = aclDrift.readers.observeBrokerMailbox;
    aclDrift.readers = {
      ...aclDrift.readers,
      observeBrokerMailbox: async (enrollment, request) => ({
        ...(await observeAcl(enrollment, request)),
        mailboxAclSha256: digest("changed-mailbox-acl"),
      }),
    };
    await expect(prepare(aclDrift)).rejects.toThrow(/differs from enrollment field mailboxAcl/u);
    expect(aclDrift.events).not.toContain("persist");

    for (const key of ["journalRootAclSha256", "journalDatabaseAclSha256"] as const) {
      const journalAclDrift = setup();
      const observeJournalAcl = journalAclDrift.readers.observeBrokerMailbox;
      journalAclDrift.readers = {
        ...journalAclDrift.readers,
        observeBrokerMailbox: async (enrollment, request) => ({
          ...(await observeJournalAcl(enrollment, request)),
          [key]: digest(`changed-${key}`),
        }),
      };
      await expect(prepare(journalAclDrift)).rejects.toThrow(
        new RegExp(`differs from enrollment field ${key}`),
      );
      expect(journalAclDrift.events).not.toContain("persist");
    }

    const helperDrift = setup();
    const observeHelper = helperDrift.readers.observeBrokerMailbox;
    helperDrift.readers = {
      ...helperDrift.readers,
      observeBrokerMailbox: async (enrollment, request) => ({
        ...(await observeHelper(enrollment, request)),
        nativeHelperSha256: digest("changed-native-helper"),
      }),
    };
    await expect(prepare(helperDrift)).rejects.toThrow(/execution native helper/u);
    expect(helperDrift.events).not.toContain("persist");
  });

  it.each([
    "mailboxRootObjectIdentitySha256",
    "mailboxTransportIdentitySha256",
    "journalRootObjectIdentitySha256",
    "journalDatabaseObjectIdentitySha256",
    "journalTransportIdentitySha256",
  ] as const)("rejects prepared role mailboxes that alias one %s", async (identityKey) => {
    const fixture = setup();
    const observations = [...fixture.brokerMailboxObservations.values()];
    const first = observations[0]!;
    const second = observations[1]!;
    fixture.brokerMailboxObservations.set(second.brokerEnrollmentSha256, {
      ...second,
      [identityKey]: first[identityKey],
    });

    await expect(prepare(fixture)).rejects.toMatchObject({
      code: "BROKER_MAILBOX_PREPARED_COLLISION",
    });
    expect(fixture.events).not.toContain("persist");
  });

  it("rejects journal roots that overlap any enrolled mailbox or journal root", async () => {
    const fixture = setup();
    const first = fixture.brokerEnrollments[0]!;
    const second = fixture.brokerEnrollments[1]!;
    const replacement = createProbeBrokerEnrollment({
      environmentId: second.environmentId,
      brokerRole: second.brokerRole,
      brokerInstanceId: second.brokerInstanceId,
      mailboxRoot: second.mailboxRoot,
      mailboxAclSha256: second.mailboxAclSha256,
      journalRoot: first.mailboxRoot,
      journalRootAclSha256: second.journalRootAclSha256,
      journalDatabaseAclSha256: second.journalDatabaseAclSha256,
      processSidSha256: second.processSidSha256,
      peerAuthoritySha256: second.peerAuthoritySha256,
    });
    fixture.brokerEnrollments = fixture.brokerEnrollments.map((entry) =>
      entry === second ? replacement : entry,
    );

    await expect(prepare(fixture)).rejects.toMatchObject({
      code: "BROKER_MAILBOX_ROOT_OVERLAP",
    });
    expect(fixture.events).toEqual([]);
  });

  it("rejects a journal database that aliases either retained root object", async () => {
    const fixture = setup();
    const observation = [...fixture.brokerMailboxObservations.values()][0]!;
    fixture.brokerMailboxObservations.set(observation.brokerEnrollmentSha256, {
      ...observation,
      journalDatabaseObjectIdentitySha256: observation.mailboxRootObjectIdentitySha256,
    });

    await expect(prepare(fixture)).rejects.toMatchObject({
      code: "BROKER_MAILBOX_PREPARED_COLLISION",
    });
    expect(fixture.events).not.toContain("persist");
  });

  it("rejects tampered, incomplete, malformed, or colliding prepared actor registries", async () => {
    const fixture = setup();
    const context = await prepare(fixture);
    const actors = context.executionBundleManifest.actors;

    const tampered = {
      ...context,
      executionBundleManifest: {
        ...context.executionBundleManifest,
        actors: { ...actors, remotePeerActorSha256: digest("tampered-peer-actor") },
      },
    };
    expect(() => validatePreparedProbeContext(tampered)).toThrow(
      /execution bundle manifest digest mismatch/u,
    );

    const incompleteActors = Object.fromEntries(
      Object.entries(actors).filter(([key]) => key !== "secondUserSidSha256"),
    );
    const incomplete = {
      ...context,
      executionBundleManifest: {
        ...context.executionBundleManifest,
        actors: incompleteActors,
      },
    };
    expect(() => validatePreparedProbeContext(incomplete)).toThrow(
      /bundle\.actors is missing key secondUserSidSha256/u,
    );

    const malformed = {
      ...context,
      executionBundleManifest: {
        ...context.executionBundleManifest,
        actors: { ...actors, primaryStandardUserSidSha256: "A".repeat(64) },
      },
    };
    expect(() => validatePreparedProbeContext(malformed)).toThrow(
      /primaryStandardUserSidSha256 must be lowercase 64-hex/u,
    );

    for (const collidingActors of [
      {
        ...actors,
        remotePeerActorSha256: actors.primaryStandardUserSidSha256,
      },
      {
        ...actors,
        remotePeerActorSha256: actors.secondUserSidSha256,
      },
    ]) {
      const colliding = {
        ...context,
        executionBundleManifest: {
          ...context.executionBundleManifest,
          actors: collidingActors,
        },
      };
      expect(() => validatePreparedProbeContext(colliding)).toThrow(
        /execution bundle actors must be pairwise distinct/u,
      );
    }
  });

  it("binds every public actor hash through bundle, scope, and prepared-context digests", async () => {
    const fixture = setup();
    const context = await prepare(fixture);
    const { executionBundleManifestSha256: originalBundleSha256, ...manifestFields } =
      context.executionBundleManifest;
    const actorKeys = [
      "primaryStandardUserSidSha256",
      "powerControlActorSha256",
      "snapshotControlActorSha256",
      "remotePeerActorSha256",
      "secondUserSidSha256",
    ] as const;

    for (const actorKey of actorKeys) {
      expect(
        deriveProbeExecutionBundleManifestDigest({
          ...manifestFields,
          actors: {
            ...manifestFields.actors,
            [actorKey]: digest(`changed-${actorKey}`),
          },
        }),
      ).not.toBe(originalBundleSha256);
    }

    fixture.state.controllerObservation = {
      ...fixture.state.controllerObservation,
      actors: {
        ...fixture.state.controllerObservation.actors,
        powerControlActorSha256: digest("changed-power-actor"),
      },
    };
    const changedContext = await prepareAuthoritativeProbeContext({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate: fixture.candidate,
      attestation: fixture.attestation,
      runAuthorization: fixture.runAuthorization,
      runAuthorizationClaim: fixture.runAuthorizationClaim,
      request: fixture.request,
      lifecyclePolicy: fixture.lifecyclePolicy,
      brokerEnrollments: fixture.brokerEnrollments,
      readers: {
        ...fixture.readers,
        readPreparationTransaction: async () => null,
        persistPreparation: async (transaction) => ({ transaction, reused: false }),
      },
      now: () => new Date("2026-08-06T10:00:00.000Z"),
    });

    expect(changedContext.executionBundleManifestSha256).not.toBe(
      context.executionBundleManifestSha256,
    );
    expect(changedContext.preparationScopeSha256).not.toBe(context.preparationScopeSha256);
    expect(changedContext.preflightSha256).not.toBe(context.preflightSha256);
  });

  it("rejects stale lifecycle data and the wrong floor/current environment mapping", async () => {
    const staleServicing = setup();
    staleServicing.lifecyclePolicy = {
      ...staleServicing.lifecyclePolicy,
      mappings: [
        {
          ...staleServicing.lifecyclePolicy.mappings[0],
          supportedUntil: "2026-08-06T10:00:00.000Z",
        },
        staleServicing.lifecyclePolicy.mappings[1],
      ],
    };
    await expect(prepare(staleServicing)).rejects.toThrow(/outside active servicing/u);

    const stalePolicy = setup();
    stalePolicy.lifecyclePolicy = {
      ...stalePolicy.lifecyclePolicy,
      evaluatedAt: "2026-08-05T09:59:59.999Z",
    };
    await expect(prepare(stalePolicy)).rejects.toThrow(/older than 24 hours/u);

    const futurePolicy = setup();
    futurePolicy.lifecyclePolicy = {
      ...futurePolicy.lifecyclePolicy,
      evaluatedAt: "2026-08-06T10:00:00.001Z",
    };
    await expect(prepare(futurePolicy)).rejects.toThrow(/in the future/u);

    const wrongMapping = setup();
    wrongMapping.lifecyclePolicy = {
      ...wrongMapping.lifecyclePolicy,
      mappings: [
        { ...wrongMapping.lifecyclePolicy.mappings[0], windowsVersion: "25H2" },
        wrongMapping.lifecyclePolicy.mappings[1],
      ],
    };
    await expect(prepare(wrongMapping)).rejects.toThrow(/environment mapping is invalid/u);
  });

  it("binds each path-specific execution bundle to its controller authorization claim", async () => {
    const fixture = setup();
    const ascii = await prepare(fixture);
    const unicodeRequest: ProbePreflightRequest = {
      ...fixture.request,
      executionBundleId: "bundle-win11-floor-unicode",
      attemptId: "attempt-spaces-unicode",
      pathProfileId: "spaces-unicode",
    };
    const unicodeGuest: ProbeGuestObservation = {
      ...fixture.state.guestObservation,
      pathProfileId: "spaces-unicode",
      guestEvidence: fixture.attestation.guestEvidenceByPathProfile[1].artifact,
      pathProfile: {
        ...fixture.state.guestObservation.pathProfile,
        profileId: "spaces-unicode",
        rootPathSha256: digest("spaces-unicode-root-path"),
        evidenceRootObjectIdentitySha256: digest("spaces-unicode-evidence-root-object-identity"),
        containsSpaces: true,
        containsUnicode: true,
      },
    };
    const unicode = await prepareAuthoritativeProbeContext({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate: fixture.candidate,
      attestation: fixture.attestation,
      runAuthorization: fixture.runAuthorization,
      runAuthorizationClaim: fixture.createRunAuthorizationClaim(
        unicodeGuest.pathProfile.evidenceRootObjectIdentitySha256,
      ),
      request: unicodeRequest,
      lifecyclePolicy: fixture.lifecyclePolicy,
      brokerEnrollments: fixture.brokerEnrollments,
      readers: {
        ...fixture.readers,
        observeGuest: async () => unicodeGuest,
      },
      now: () => new Date("2026-08-06T10:00:00.000Z"),
    });

    expect(unicode.executionBundleManifestSha256).not.toBe(ascii.executionBundleManifestSha256);
    expect(unicode.preparationScopeSha256).not.toBe(ascii.preparationScopeSha256);
    expect(unicode.executionBundleManifest).not.toHaveProperty("attemptId");
    expect(unicode.executionBundleManifest).not.toHaveProperty("pathProfileId");
    expect(unicode.pathProfileObservation.profileId).toBe("spaces-unicode");
    expect(unicode.executionBundleManifest.evidenceArtifacts).toContainEqual(
      fixture.attestation.guestEvidenceByPathProfile[1].artifact,
    );
    expect(unicode.executionBundleManifest.evidenceArtifacts).not.toContainEqual(
      fixture.attestation.guestEvidenceByPathProfile[0].artifact,
    );
  });

  it("rejects dirty or source-drifted repositories before issuing a preparation claim", async () => {
    const dirty = setup();
    dirty.state.repositoryState = { ...dirty.state.repositoryState, repositoryDirty: true };
    await expect(prepare(dirty)).rejects.toThrow(/requires a clean repository/u);
    expect(dirty.events).not.toContain("persist");

    const drift = setup();
    drift.state.repositoryState = {
      ...drift.state.repositoryState,
      sourceHashes: [
        ...drift.state.repositoryState.sourceHashes.slice(0, 1),
        { ...drift.state.repositoryState.sourceHashes[1], sha256: digest("drift") },
      ],
    };
    await expect(prepare(drift)).rejects.toThrow(/does not match the candidate source identity/u);
  });

  it("rejects guest runtime, execution identity, and path-profile drift", async () => {
    const evidence = setup();
    evidence.state.guestObservation = {
      ...evidence.state.guestObservation,
      guestEvidence: evidence.attestation.guestEvidenceByPathProfile[1].artifact,
    };
    await expect(prepare(evidence)).rejects.toThrow(/differs from its attestation/u);

    const runtime = setup();
    runtime.state.guestObservation = {
      ...runtime.state.guestObservation,
      runtime: { ...runtime.state.guestObservation.runtime, nodeVersion: "24.6.0" },
    };
    await expect(prepare(runtime)).rejects.toThrow(/differs from its attestation/u);

    const boot = setup();
    boot.state.guestObservation = {
      ...boot.state.guestObservation,
      bootIdSha256: digest("other-boot"),
    };
    await expect(prepare(boot)).rejects.toThrow(/snapshot, boot, or session identity/u);

    const path = setup();
    path.state.guestObservation = {
      ...path.state.guestObservation,
      pathProfile: { ...path.state.guestObservation.pathProfile, networkPath: true },
    };
    await expect(prepare(path)).rejects.toThrow(/requested path profile/u);
  });

  it("rejects controller capability, actor, and identity drift", async () => {
    const capability = setup();
    capability.state.controllerObservation = {
      ...capability.state.controllerObservation,
      capabilities: {
        ...capability.state.controllerObservation.capabilities,
        externalAbruptPower: false,
      },
    };
    await expect(prepare(capability)).rejects.toThrow(/differs from its attestation/u);

    const actor = setup();
    actor.state.controllerObservation = {
      ...actor.state.controllerObservation,
      actors: {
        ...actor.state.controllerObservation.actors,
        secondUserSidSha256: actor.attestation.host.standardUserSidSha256,
      },
    };
    await expect(prepare(actor)).rejects.toThrow(/distinct and independent/u);
  });

  it("rejects unstable artifacts, hash drift, and a non-AMD64 helper", async () => {
    const unstable = setup();
    const stableReader = unstable.readers.readVerifiedBinaryArtifact;
    unstable.readers = {
      ...unstable.readers,
      readVerifiedBinaryArtifact: async (
        reference: Parameters<ProbePreflightReaders["readVerifiedBinaryArtifact"]>[0],
      ) => ({
        ...(await stableReader(reference)),
        stableRead: false,
      }),
    } as unknown as ProbePreflightReaders;
    await expect(prepare(unstable)).rejects.toThrow(/exact stable regular artifact/u);

    const badPe = setup({ helperBytes: Buffer.from("not a PE", "utf8") });
    await expect(prepare(badPe)).rejects.toThrow(/not a PE executable/u);
  });

  it("rejects malformed native build identities before reading live authority", async () => {
    for (const key of ["nativeCandidateDigest", "nativeManifestSha256"] as const) {
      const fixture = setup();
      fixture.request = { ...fixture.request, [key]: "not-a-sha256" };
      await expect(prepare(fixture)).rejects.toMatchObject({ code: "PREFLIGHT_SHA256" });
      expect(fixture.events).toEqual([]);
    }
  });

  it("replays the first exact preparation after a post-write crash and an advancing clock", async () => {
    const fixture = setup();
    let retainedTransaction: ProbePreparationTransaction | undefined;
    let simulateCrash = true;
    fixture.readers = {
      ...fixture.readers,
      readPreparationTransaction: async (requestSha256: string) =>
        retainedTransaction?.requestSha256 === requestSha256 ? retainedTransaction : null,
      persistPreparation: async (transaction: ProbePreparationTransaction) => {
        retainedTransaction ??= transaction;
        if (simulateCrash) {
          simulateCrash = false;
          throw new Error("simulated caller crash after durable transaction");
        }
        return { transaction: retainedTransaction, reused: true } as const;
      },
    } as unknown as ProbePreflightReaders;

    await expect(prepare(fixture)).rejects.toThrow(/simulated caller crash/u);
    fixture.readers = {
      ...fixture.readers,
      readRepositoryState: async () => {
        throw new Error("exact recovery must not reread repository state");
      },
      observeGuest: async () => {
        throw new Error("exact recovery must not observe the guest");
      },
      observeController: async () => {
        throw new Error("exact recovery must not observe the controller");
      },
      readVerifiedBinaryArtifact: async () => {
        throw new Error("exact recovery must not reread binaries");
      },
    } as ProbePreflightReaders;
    const recovered = await prepare(fixture, "2026-08-07T10:00:30.000Z");
    const replayed = await prepare(fixture, "2026-08-07T10:00:45.000Z");

    expect(recovered).toEqual(retainedTransaction?.preparedContext);
    expect(recovered.trustedEvaluationAt).toBe("2026-08-06T10:00:00.000Z");
    expect(replayed).toEqual(recovered);
  });

  it.each([
    "mailboxRoot",
    "mailboxAclSha256",
    "journalRoot",
    "journalRootAclSha256",
    "journalDatabaseAclSha256",
    "processSidSha256",
  ] as const)("rejects recovery when the current static broker %s differs", async (staticKey) => {
    const fixture = setup();
    await prepare(fixture);
    const retained = fixture.brokerEnrollments.find(
      (entry) =>
        entry.environmentId === fixture.request.environmentId &&
        entry.brokerRole === "primary-standard-user",
    )!;
    const replacement = createProbeBrokerEnrollment({
      environmentId: retained.environmentId,
      brokerRole: retained.brokerRole,
      brokerInstanceId: retained.brokerInstanceId,
      mailboxRoot:
        staticKey === "mailboxRoot"
          ? "E:\\Broker\\win11-floor\\replacement-primary"
          : retained.mailboxRoot,
      mailboxAclSha256:
        staticKey === "mailboxAclSha256"
          ? digest("replacement-primary-mailbox-acl")
          : retained.mailboxAclSha256,
      journalRoot:
        staticKey === "journalRoot"
          ? "E:\\BrokerJournal\\win11-floor\\replacement-primary"
          : retained.journalRoot,
      journalRootAclSha256:
        staticKey === "journalRootAclSha256"
          ? digest("replacement-primary-journal-root-acl")
          : retained.journalRootAclSha256,
      journalDatabaseAclSha256:
        staticKey === "journalDatabaseAclSha256"
          ? digest("replacement-primary-journal-database-acl")
          : retained.journalDatabaseAclSha256,
      processSidSha256:
        staticKey === "processSidSha256"
          ? digest("replacement-primary-process-sid")
          : retained.processSidSha256,
      peerAuthoritySha256: retained.peerAuthoritySha256,
    });
    fixture.brokerEnrollments = fixture.brokerEnrollments.map((entry) =>
      entry === retained ? replacement : entry,
    );

    await expect(prepare(fixture, "2026-08-06T10:00:30.000Z")).rejects.toMatchObject({
      code: "PREFLIGHT_TRANSACTION_COLLISION",
    });
  });

  it("rejects a new preparation at authorization expiry before live observation", async () => {
    const fixture = setup();
    await expect(prepare(fixture, fixture.runAuthorization.expiresAt)).rejects.toMatchObject({
      code: "PREFLIGHT_RUN_AUTH_EXPIRED",
    });
    expect(fixture.events).toEqual(["read-preparation"]);
  });

  it("rejects a reused preparation transaction when any verified observation changed", async () => {
    const fixture = setup();
    let retainedTransaction: ProbePreparationTransaction | undefined;
    fixture.readers = {
      ...fixture.readers,
      persistPreparation: async (transaction: ProbePreparationTransaction) => {
        if (retainedTransaction === undefined) {
          retainedTransaction = transaction;
          return { transaction, reused: false } as const;
        }
        return { transaction: retainedTransaction, reused: true } as const;
      },
    } as unknown as ProbePreflightReaders;

    await prepare(fixture);
    fixture.state.guestObservation = {
      ...fixture.state.guestObservation,
      pathProfile: {
        ...fixture.state.guestObservation.pathProfile,
        evidenceRootObjectIdentitySha256: digest("changed-ascii-evidence-root"),
      },
    };
    fixture.runAuthorizationClaim = fixture.createRunAuthorizationClaim(
      fixture.state.guestObservation.pathProfile.evidenceRootObjectIdentitySha256,
    );

    await expect(prepare(fixture, "2026-08-06T10:00:30.000Z")).rejects.toThrow(
      /differs from current verified inputs/u,
    );
  });

  it("rejects a tampered retained preparation transaction", async () => {
    const fixture = setup();
    fixture.readers = {
      ...fixture.readers,
      persistPreparation: async (transaction: ProbePreparationTransaction) => {
        const tampered = {
          ...transaction,
          claimReceiptSha256: digest("another-preparation-claim"),
        };
        return {
          transaction: {
            ...tampered,
            transactionSha256: deriveProbePreparationTransactionDigest(tampered),
          },
          reused: true,
        } as const;
      },
    } as unknown as ProbePreflightReaders;

    await expect(prepare(fixture)).rejects.toThrow(/transaction context binding is invalid/u);
  });
});
