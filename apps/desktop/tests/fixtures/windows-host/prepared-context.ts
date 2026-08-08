import { createHash } from "node:crypto";

import {
  PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
  PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
  PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
  type ProbePreparedBrokerEnrollment,
} from "../../../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { PROBE_BROKER_ROLES } from "../../../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  type ProbeEnvironmentId,
  type ProbePathProfileId,
} from "../../../scripts/windows-host-falsifier/probe-contract.mjs";
import {
  derivePreparedProbeContextDigest,
  deriveProbeExecutionBundleManifestDigest,
  deriveProbePreparationClaimReceiptDigest,
  deriveProbePreparationScopeDigest,
  type PreparedProbeContext,
} from "../../../scripts/windows-host-falsifier/probe-preflight.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "../../../scripts/windows-host-falsifier/probe-runner.mjs";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface PreparedContextFixtureOptions {
  readonly campaignRunId?: string;
  readonly executionRunId?: string;
  readonly executionBundleId?: string;
  readonly attemptId?: string;
  readonly environmentId?: ProbeEnvironmentId;
  readonly pathProfileId?: ProbePathProfileId;
  readonly candidateSha256?: string;
  readonly labAttestationSha256?: string;
  readonly runPlanSha256?: string;
  readonly runAuthorizationSha256?: string;
  readonly runAuthorizationClaimReceiptSha256?: string;
  readonly lifecyclePolicySha256?: string;
  readonly vmSnapshotId?: string;
  readonly bootIdSha256?: string;
  readonly runnerSessionIdSha256?: string;
  readonly preflightRootPathSha256?: string;
  readonly evidenceRootObjectIdentitySha256?: string;
  readonly volumeIdSha256?: string;
  readonly controller?: {
    readonly identitySha256: string;
    readonly publicKeySha256: string;
    readonly publicKeyArtifact: { readonly path: string; readonly sha256: string };
    readonly version: string;
  };
  readonly actors?: {
    readonly primaryStandardUserSidSha256: string;
    readonly powerControlActorSha256: string;
    readonly snapshotControlActorSha256: string;
    readonly remotePeerActorSha256: string;
    readonly secondUserSidSha256: string;
  };
  readonly nativeHelper?: {
    readonly path: string;
    readonly sha256: string;
    readonly nativeCandidateDigest: string;
    readonly nativeManifestSha256: string;
  };
  readonly nsis?: { readonly path: string; readonly sha256: string };
  readonly brokerEnrollments?: readonly ProbePreparedBrokerEnrollment[];
}

export function createPreparedContextFixture(
  options: PreparedContextFixtureOptions = {},
): PreparedProbeContext {
  const environmentId = options.environmentId ?? "win11-floor";
  const pathProfileId = options.pathProfileId ?? "ascii";
  const campaignRunId = options.campaignRunId ?? "campaign-one";
  const executionRunId = options.executionRunId ?? "execution-one";
  const executionBundleId = options.executionBundleId ?? "bundle-one";
  const attemptId = options.attemptId ?? "attempt-one";
  const candidateSha256 = options.candidateSha256 ?? sha256("candidate");
  const labAttestationSha256 = options.labAttestationSha256 ?? sha256("attestation");
  const runPlanSha256 = options.runPlanSha256 ?? PROBE_RUN_PLAN_SHA256;
  const runAuthorizationSha256 = options.runAuthorizationSha256 ?? sha256("run-authorization");
  const runAuthorizationClaimReceiptSha256 =
    options.runAuthorizationClaimReceiptSha256 ?? sha256("run-authorization-claim");
  const lifecyclePolicySha256 = options.lifecyclePolicySha256 ?? sha256("lifecycle-policy");
  const trustedEvaluationAt = "2026-08-07T00:00:00.000Z";
  const controller =
    options.controller ??
    ({
      identitySha256: sha256("controller"),
      publicKeySha256: sha256("controller-key"),
      publicKeyArtifact: {
        path: "attestations/controller-public-key.spki.der",
        sha256: sha256("controller-key"),
      },
      version: "1.2.3",
    } as const);
  const actors =
    options.actors ??
    ({
      primaryStandardUserSidSha256: sha256("primary-standard-user"),
      powerControlActorSha256: sha256("power-control-actor"),
      snapshotControlActorSha256: sha256("snapshot-control-actor"),
      remotePeerActorSha256: sha256("remote-peer-actor"),
      secondUserSidSha256: sha256("second-standard-user"),
    } as const);
  const nativeHelper =
    options.nativeHelper ??
    ({
      path: "bin/native-helper.exe",
      sha256: sha256("native-helper"),
      nativeCandidateDigest: sha256("native-candidate"),
      nativeManifestSha256: sha256("native-manifest"),
    } as const);
  const nsis = options.nsis ?? ({ path: "bin/nsis.exe", sha256: sha256("nsis") } as const);
  const vmSnapshotId = options.vmSnapshotId ?? "snapshot-one";
  const bootIdSha256 = options.bootIdSha256 ?? sha256("boot");
  const runnerSessionIdSha256 = options.runnerSessionIdSha256 ?? sha256("runner-session");
  const containsSpaces = pathProfileId === "spaces-unicode";
  const brokerEnrollments =
    options.brokerEnrollments ??
    PROBE_BROKER_ROLES.map((brokerRole) => {
      const processSidSha256 =
        brokerRole === "primary-standard-user"
          ? actors.primaryStandardUserSidSha256
          : brokerRole === "second-user"
            ? actors.secondUserSidSha256
            : sha256("remote-peer-process-sid");
      const enrollment = createProbeBrokerEnrollment({
        environmentId,
        brokerRole,
        brokerInstanceId: `${environmentId}-${brokerRole}-broker`,
        mailboxRoot: `E:\\Broker\\${environmentId}\\${brokerRole}`,
        mailboxAclSha256: sha256(`${brokerRole}-mailbox-acl`),
        journalRoot: `E:\\BrokerJournal\\${environmentId}\\${brokerRole}`,
        journalRootAclSha256: sha256(`${brokerRole}-journal-root-acl`),
        journalDatabaseAclSha256: sha256(`${brokerRole}-journal-database-acl`),
        processSidSha256,
        peerAuthoritySha256: brokerRole === "remote-peer" ? actors.remotePeerActorSha256 : null,
      });
      return createProbePreparedBrokerEnrollment(enrollment, {
        schemaVersion: 1,
        kind: PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
        brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
        environmentId,
        brokerRole,
        brokerInstanceId: enrollment.brokerInstanceId,
        mailboxRoot: enrollment.mailboxRoot,
        mailboxSecurityProfile: PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
        mailboxAclSha256: enrollment.mailboxAclSha256,
        mailboxOwnerSidSha256: processSidSha256,
        processSidSha256,
        peerAuthoritySha256: enrollment.peerAuthoritySha256,
        mailboxRootObjectIdentitySha256: sha256(`${brokerRole}-mailbox-object`),
        mailboxVolumeIdSha256: sha256(`${brokerRole}-mailbox-volume`),
        mailboxTransportIdentitySha256: sha256(`${brokerRole}-mailbox-transport`),
        mailboxFileSystem: "NTFS",
        mailboxDriveType: "fixed",
        mailboxLocalAbsolute: true,
        mailboxNetworkPath: false,
        mailboxReparsePoint: false,
        journalRoot: enrollment.journalRoot,
        journalSecurityProfile: PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
        journalRootPathSha256: sha256(`${brokerRole}-journal-root-path`),
        journalRootObjectIdentitySha256: sha256(`${brokerRole}-journal-root-object`),
        journalVolumeIdSha256: sha256(`${brokerRole}-journal-volume`),
        journalRootOwnerSidSha256: processSidSha256,
        journalRootAclSha256: enrollment.journalRootAclSha256,
        journalDatabasePathSha256: sha256(`${brokerRole}-journal-database-path`),
        journalDatabaseObjectIdentitySha256: sha256(`${brokerRole}-journal-database-object`),
        journalDatabaseOwnerSidSha256: processSidSha256,
        journalDatabaseAclSha256: enrollment.journalDatabaseAclSha256,
        journalTransportIdentitySha256: sha256(`${brokerRole}-journal-transport`),
        journalFileSystem: "NTFS",
        journalDriveType: "fixed",
        journalLocalAbsolute: true,
        journalNetworkPath: false,
        journalReparsePoint: false,
        bootIdSha256: brokerRole === "remote-peer" ? sha256("remote-peer-boot") : bootIdSha256,
        runnerSessionIdSha256:
          brokerRole === "primary-standard-user"
            ? runnerSessionIdSha256
            : sha256(`${brokerRole}-runner-session`),
        nativeHelperSha256: nativeHelper.sha256,
        nativeObservationSha256: sha256(`${brokerRole}-native-observation`),
      });
    });

  const evidenceArtifacts = [
    { path: controller.publicKeyArtifact.path, sha256: controller.publicKeyArtifact.sha256 },
    { path: "attestations/controller.json", sha256: sha256("controller-evidence") },
    { path: "attestations/guest.json", sha256: sha256("guest-evidence") },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const executionBundleDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-execution-bundle" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256,
    labAttestationSha256,
    campaignRunId,
    executionRunId,
    executionBundleId,
    environmentId,
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
    vm: { vmSnapshotId, bootIdSha256, runnerSessionIdSha256 },
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
      nsisExecutableSha256: nsis.sha256,
    },
    controller,
    actors,
    brokerEnrollments,
    evidenceArtifacts,
    binaries: {
      nativeHelper: { ...nativeHelper, machine: "x64" as const },
      nsis,
    },
  };
  const executionBundleManifest = {
    ...executionBundleDraft,
    executionBundleManifestSha256: deriveProbeExecutionBundleManifestDigest(executionBundleDraft),
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
    campaignRunId,
    executionRunId,
    executionBundleId,
    executionBundleManifestSha256: executionBundleManifest.executionBundleManifestSha256,
    attemptId,
    environmentId,
    pathProfileId,
    vmSnapshotId,
    bootIdSha256,
    runnerSessionIdSha256,
    lifecyclePolicySha256,
    trustedEvaluationAt,
    controllerPublicKeyArtifact: controller.publicKeyArtifact,
    pathProfileObservation: {
      profileId: pathProfileId,
      rootPathSha256: options.preflightRootPathSha256 ?? sha256("root-path"),
      evidenceRootObjectIdentitySha256:
        options.evidenceRootObjectIdentitySha256 ?? sha256("root-object"),
      volumeIdSha256: options.volumeIdSha256 ?? sha256("volume"),
      localAbsolute: true,
      networkPath: false,
      removableVolume: false,
      reparsePoint: false,
      nfcNormalized: true,
      containsSpaces,
      containsUnicode: containsSpaces,
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
