import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROBE_CAMPAIGN_MANIFEST,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  deriveCandidateDigest,
  deriveLabAttestationDigest,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type {
  ProbeCandidateDigestFields,
  ProbeLabAttestation,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import {
  appendContinuation,
  closeContinuation,
  initializeContinuation,
} from "../scripts/windows-host-falsifier/continuation.mjs";
import { openEvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import {
  createProbeControllerActionAttestation,
  probeControllerActionAttestationPath,
} from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import {
  deriveControllerEvidenceSealReceiptDigest,
  finalizeProbeCampaign,
  finalizeProbeSegment,
  probeSegmentArtifactPaths,
  verifyCommittedProbeSegment,
  verifyControllerEvidenceSealReceipt,
  verifyFinalizedProbeSegment,
} from "../scripts/windows-host-falsifier/probe-finalizer.mjs";
import type {
  ControllerEvidenceSealReceipt,
  NativeEvidenceSeal,
  ProbeFinalizerAdapters,
} from "../scripts/windows-host-falsifier/probe-finalizer.mjs";
import {
  deriveProbeFinalizationOperationDigest,
  deriveProbeQuiescenceAbandonmentReceiptDigest,
  deriveProbeQuiescenceCompletionReceiptDigest,
  deriveProbeQuiescenceLeaseReceiptDigest,
} from "../scripts/windows-host-falsifier/probe-finalization-lease.mjs";
import type {
  ProbeFinalizationIntent,
  ProbeQuiescenceCompletionReceipt,
  ProbeQuiescenceLeaseReceipt,
  ProbeSegmentProof,
} from "../scripts/windows-host-falsifier/probe-finalization-lease.mjs";
import {
  derivePreparedProbeContextDigest,
  deriveProbeExecutionBundleManifestDigest,
  deriveProbePreparationClaimReceiptDigest,
  deriveProbePreparationScopeDigest,
} from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import type {
  PreparedProbeContext,
  ProbeExecutionBundleManifest,
  ProbeRepositoryState,
} from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import {
  PROBE_RUN_PLAN_SHA256,
  getProbeRunWorkItem,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import {
  deriveProbeRunAuthorizationClaimReceiptDigest,
  deriveProbeRunAuthorizationDigest,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import type {
  ProbeRunAuthorization,
  ProbeRunAuthorizationClaimReceipt,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import {
  PROBE_VERIFIER_SOURCE_PATH,
  getProbeVerifierDefinition,
} from "../scripts/windows-host-falsifier/probe-registry.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";
import { loadRetainedProbeVerifier } from "../scripts/windows-host-falsifier/probe-verifier-isolate.mjs";
import { deriveControllerSourceTranscriptReceiptDigest } from "../scripts/windows-host-falsifier/probe-transcript.mjs";
import type {
  ProbeControllerSourceTranscriptReceipt,
  ProbeSourceTranscript,
  ProbeTranscriptFactValue,
  ProbeTranscriptObservation,
} from "../scripts/windows-host-falsifier/probe-transcript.mjs";
import { createPreparedContextFixture } from "./fixtures/windows-host/prepared-context.js";

const temporaryDirectories: string[] = [];
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const labeledDigest = (label: string) => hashProbeCanonicalJson({ label });
const probeContractSourcePath = "apps/desktop/scripts/windows-host-falsifier/probe-contract.mjs";
const probeTranscriptSourcePath =
  "apps/desktop/scripts/windows-host-falsifier/probe-transcript.mjs";
const nativeClientSourcePath = "apps/desktop/scripts/windows-host-falsifier/native-client.mjs";
const nativeManifestDigestSourcePath =
  "apps/desktop/scripts/windows-host-falsifier/native-manifest-digest.mjs";
const retainedNativeManifestDigestPath = "campaign/verifiers/native-manifest-digest.mjs";

function compactCanonicalDigest(value: unknown) {
  return digest(JSON.stringify(JSON.parse(canonicalProbeJson(value))));
}

function framedDigest(fields: readonly string[]) {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "enduragent-finalizer-"));
  temporaryDirectories.push(root);
  return openEvidenceStore({ root });
}

async function ensureDirectory(store: Awaited<ReturnType<typeof createStore>>, path: string) {
  let current = "";
  for (const part of path.split("/")) {
    current = current.length === 0 ? part : `${current}/${part}`;
    try {
      await store.createDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function writeBytes(
  store: Awaited<ReturnType<typeof createStore>>,
  path: string,
  bytes: Uint8Array | string,
) {
  await ensureDirectory(store, path.split("/").slice(0, -1).join("/"));
  return store.writeBytes(path, bytes);
}

async function makeNativeSeal(
  store: Awaited<ReturnType<typeof createStore>>,
  exactArtifactPaths: readonly string[],
  rootObjectIdentity: string,
): Promise<NativeEvidenceSeal> {
  const entries = await Promise.all(
    [...exactArtifactPaths]
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      .map(async (path) => {
        const artifact = await store.readArtifact(path);
        return {
          path,
          type: "file" as const,
          bytes: artifact.bytes.byteLength,
          sha256: artifact.sha256,
          objectIdentity: `synthetic-object:${labeledDigest(path)}`,
        };
      }),
  );
  const framed = ["enduragent.windows-evidence-artifact-set-seal.v1", rootObjectIdentity];
  for (const entry of entries) {
    framed.push(entry.path, entry.type, String(entry.bytes), entry.sha256, entry.objectIdentity);
  }
  return {
    mode: "exact-paths",
    rootObjectIdentity,
    entryCount: entries.length,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    setSha256: framedDigest(framed),
  };
}

function makeCandidate(
  verifierSourceSha256: string,
  contractSourceSha256: string,
  transcriptSourceSha256: string,
  nativeClientSourceSha256: string,
  nativeManifestDigestSourceSha256: string,
  { includeNativeManifestDigest = true } = {},
) {
  const fields: ProbeCandidateDigestFields = {
    schemaVersion: 1,
    kind: "windows-host-probe-candidate",
    repositoryCommit: "c".repeat(40),
    sourceHashes: [
      { path: nativeClientSourcePath, sha256: nativeClientSourceSha256 },
      ...(includeNativeManifestDigest
        ? [
            {
              path: nativeManifestDigestSourcePath,
              sha256: nativeManifestDigestSourceSha256,
            },
          ]
        : []),
      { path: probeContractSourcePath, sha256: contractSourceSha256 },
      { path: PROBE_VERIFIER_SOURCE_PATH, sha256: verifierSourceSha256 },
      { path: probeTranscriptSourcePath, sha256: transcriptSourceSha256 },
    ],
    binaryHashes: [
      { path: "bin/native-helper.exe", sha256: labeledDigest("native-helper") },
      { path: "toolchain/nsis.exe", sha256: labeledDigest("nsis") },
    ],
    compiler: {
      provider: "Microsoft.CSharp.CSharpCodeProvider",
      codeDomProviderAssemblyVersion: "4.0.0.0",
      cscFileVersion: "4.8.9256.0",
      cscSha256: labeledDigest("csc"),
      outputType: "ConsoleApplication",
      platform: "x64",
    },
    toolchain: {
      nodeVersion: "24.11.1",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      powerShellVersion: "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256: labeledDigest("powershell"),
      clrVersion: "v4.0.30319",
      runtimeDirectorySha256Before: labeledDigest("runtime"),
      runtimeDirectorySha256After: labeledDigest("runtime"),
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
    configurationSha256: labeledDigest("configuration"),
  };
  return { ...fields, candidateSha256: deriveCandidateDigest(fields) };
}

function makeAttestation(
  publicKeyBytes: Uint8Array,
  evidence: {
    guestAscii: { path: string; sha256: string };
    guestUnicode: { path: string; sha256: string };
    controller: { path: string; sha256: string };
  },
) {
  const fields: Omit<ProbeLabAttestation, "attestationSha256"> = {
    schemaVersion: 1,
    kind: "sanitized-windows-11-lab-attestation",
    environmentId: "win11-floor",
    sanitized: true,
    host: {
      windowsEdition: "Windows 11 Pro",
      osCaption: "Microsoft Windows 11 Pro",
      windowsVersion: "24H2",
      osBuild: "26100",
      patchLevel: "synthetic-finalizer-fixture",
      productType: "workstation",
      machineArchitecture: "x64",
      processArchitecture: "x64",
      systemVolumeFileSystem: "NTFS",
      systemVolumeIdSha256: labeledDigest("system-volume"),
      testVolumeFileSystem: "NTFS",
      testVolumeIdSha256: labeledDigest("test-volume"),
      standardUserSidSha256: labeledDigest("standard-user"),
      elevated: false,
      defenderRealtimeEnabled: true,
      uacDefault: true,
      developerModeEnabled: false,
    },
    snapshot: {
      vmImageId: "win11-floor-image",
      vmImageSha256: labeledDigest("vm-image"),
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
      interactiveSessionOwnerSidSha256: labeledDigest("standard-user"),
    },
    runtime: {
      nodeVersion: "24.11.1",
      powerShellVersion: "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256: labeledDigest("powershell"),
      clrVersion: "v4.0.30319",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      nsisExecutableSha256: labeledDigest("nsis"),
    },
    controller: {
      identitySha256: labeledDigest("controller-identity"),
      publicKeySha256: digest(publicKeyBytes),
      publicKeyArtifact: {
        path: "attestations/controller-public-key.spki.der",
        sha256: digest(publicKeyBytes),
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
      { pathProfileId: "ascii", artifact: evidence.guestAscii },
      { pathProfileId: "spaces-unicode", artifact: evidence.guestUnicode },
    ],
    controllerEvidence: evidence.controller,
  };
  return { ...fields, attestationSha256: deriveLabAttestationDigest(fields) };
}

function attestedGuestEvidence(
  attestation: ProbeLabAttestation,
  pathProfileId: "ascii" | "spaces-unicode" = "ascii",
) {
  const entry = attestation.guestEvidenceByPathProfile.find(
    (candidate) => candidate.pathProfileId === pathProfileId,
  );
  if (entry === undefined) throw new Error("attested guest evidence fixture is missing");
  return entry.artifact;
}

function makeRunAuthorization({
  candidate,
  attestation,
  operatorPrivateKey,
}: {
  candidate: ReturnType<typeof makeCandidate>;
  attestation: ReturnType<typeof makeAttestation>;
  operatorPrivateKey: KeyObject;
}): ProbeRunAuthorization {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: candidate.candidateSha256,
    campaignRunId: "campaign-run-one",
    attestations: [
      { environmentId: "win11-current" as const, attestationSha256: labeledDigest("current") },
      {
        environmentId: attestation.environmentId,
        attestationSha256: attestation.attestationSha256,
      },
    ],
    issuedAt: "2026-08-06T09:00:00.000Z",
    expiresAt: "2026-08-07T09:00:00.000Z",
    operatorKeyId: "operator-one",
    trustStoreId: "windows-lab-operators",
    trustStoreGeneration: 7,
    signatureAlgorithm: "Ed25519" as const,
  };
  const authorizationSha256 = deriveProbeRunAuthorizationDigest(unsigned);
  return {
    ...unsigned,
    authorizationSha256,
    signatureBase64: sign(
      null,
      Buffer.from(authorizationSha256, "hex"),
      operatorPrivateKey,
    ).toString("base64"),
  };
}

function makeRunAuthorizationClaim({
  runAuthorization,
  attestation,
  evidenceRootObjectIdentitySha256,
  operatorPublicKeyBytes,
  controllerPrivateKey,
}: {
  runAuthorization: ProbeRunAuthorization;
  attestation: ReturnType<typeof makeAttestation>;
  evidenceRootObjectIdentitySha256: string;
  operatorPublicKeyBytes: Uint8Array;
  controllerPrivateKey: KeyObject;
}): ProbeRunAuthorizationClaimReceipt {
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
    operatorPublicKeySha256: digest(operatorPublicKeyBytes),
    trustStoreId: runAuthorization.trustStoreId,
    trustStoreGeneration: runAuthorization.trustStoreGeneration,
    trustStoreSha256: labeledDigest("protected-operator-trust-store-generation-seven"),
    verifiedAt: "2026-08-06T09:30:00.000Z",
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
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), controllerPrivateKey).toString(
      "base64",
    ),
  };
}

function makePreparedContext({
  candidate,
  attestation,
  evidenceRootObjectIdentitySha256,
  runAuthorization,
  runAuthorizationClaim,
}: {
  candidate: ReturnType<typeof makeCandidate>;
  attestation: ReturnType<typeof makeAttestation>;
  evidenceRootObjectIdentitySha256: string;
  runAuthorization: ProbeRunAuthorization;
  runAuthorizationClaim: ProbeRunAuthorizationClaimReceipt;
}) {
  const sourceSetSha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-source-set.v1",
    sourceHashes: candidate.sourceHashes,
  });
  const evidenceArtifacts = [
    attestedGuestEvidence(attestation),
    attestation.controllerEvidence,
    attestation.controller.publicKeyArtifact,
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const vm = {
    vmSnapshotId: attestation.snapshot.vmSnapshotId,
    bootIdSha256: labeledDigest("boot"),
    runnerSessionIdSha256: labeledDigest("runner-session"),
  };
  const actors = {
    primaryStandardUserSidSha256: attestation.host.standardUserSidSha256,
    powerControlActorSha256: labeledDigest("power-control-actor"),
    snapshotControlActorSha256: labeledDigest("snapshot-control-actor"),
    remotePeerActorSha256: labeledDigest("remote-peer-actor"),
    secondUserSidSha256: labeledDigest("second-standard-user"),
  };
  const nativeHelper = {
    path: "bin/native-helper.exe",
    sha256: labeledDigest("native-helper"),
    nativeCandidateDigest: labeledDigest("native-candidate"),
    nativeManifestSha256: labeledDigest("native-manifest"),
  };
  const brokerEnrollments = createPreparedContextFixture({
    environmentId: "win11-floor",
    actors,
    nativeHelper,
    bootIdSha256: vm.bootIdSha256,
    runnerSessionIdSha256: vm.runnerSessionIdSha256,
  }).executionBundleManifest.brokerEnrollments;
  const bundleFields: Omit<ProbeExecutionBundleManifest, "executionBundleManifestSha256"> = {
    schemaVersion: 1,
    kind: "windows-host-probe-execution-bundle",
    campaignId: "f01-f10-native-probe-v1",
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: candidate.candidateSha256,
    labAttestationSha256: attestation.attestationSha256,
    campaignRunId: "campaign-run-one",
    executionRunId: "execution-win11-floor",
    executionBundleId: "bundle-win11-floor",
    environmentId: "win11-floor",
    authorization: {
      runPlanSha256: runAuthorization.runPlanSha256,
      runAuthorizationSha256: runAuthorization.authorizationSha256,
      claimReceiptSha256: runAuthorizationClaim.receiptSha256,
      operatorKeyId: runAuthorizationClaim.operatorKeyId,
      operatorPublicKeySha256: runAuthorizationClaim.operatorPublicKeySha256,
      trustStoreId: runAuthorizationClaim.trustStoreId,
      trustStoreGeneration: runAuthorizationClaim.trustStoreGeneration,
      trustStoreSha256: runAuthorizationClaim.trustStoreSha256,
      verifiedAt: runAuthorizationClaim.verifiedAt,
      authorizationExpiresAt: runAuthorizationClaim.authorizationExpiresAt,
    },
    repository: { repositoryCommit: candidate.repositoryCommit, sourceSetSha256 },
    lifecyclePolicySha256: labeledDigest("lifecycle-policy"),
    trustedEvaluationAt: "2026-08-06T10:00:00.000Z",
    vm,
    runtime: attestation.runtime,
    controller: attestation.controller,
    actors,
    brokerEnrollments,
    evidenceArtifacts,
    binaries: {
      nativeHelper: {
        ...nativeHelper,
        machine: "x64",
      },
      nsis: { path: "toolchain/nsis.exe", sha256: labeledDigest("nsis") },
    },
  };
  const executionBundleManifest: ProbeExecutionBundleManifest = {
    ...bundleFields,
    executionBundleManifestSha256: deriveProbeExecutionBundleManifestDigest(bundleFields),
  };
  const contextDraft = {
    schemaVersion: 1,
    kind: "windows-host-probe-prepared-context",
    campaignId: "f01-f10-native-probe-v1",
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: candidate.candidateSha256,
    labAttestationSha256: attestation.attestationSha256,
    runPlanSha256: runAuthorization.runPlanSha256,
    runAuthorizationSha256: runAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: runAuthorizationClaim.receiptSha256,
    campaignRunId: bundleFields.campaignRunId,
    executionRunId: bundleFields.executionRunId,
    executionBundleId: bundleFields.executionBundleId,
    executionBundleManifestSha256: executionBundleManifest.executionBundleManifestSha256,
    attemptId: "attempt-ascii",
    environmentId: "win11-floor",
    pathProfileId: "ascii",
    vmSnapshotId: bundleFields.vm.vmSnapshotId,
    bootIdSha256: bundleFields.vm.bootIdSha256,
    runnerSessionIdSha256: bundleFields.vm.runnerSessionIdSha256,
    lifecyclePolicySha256: bundleFields.lifecyclePolicySha256,
    trustedEvaluationAt: bundleFields.trustedEvaluationAt,
    controllerPublicKeyArtifact: attestation.controller.publicKeyArtifact,
    pathProfileObservation: {
      profileId: "ascii",
      rootPathSha256: labeledDigest("root-path"),
      evidenceRootObjectIdentitySha256,
      volumeIdSha256: attestation.host.testVolumeIdSha256,
      localAbsolute: true,
      networkPath: false,
      removableVolume: false,
      reparsePoint: false,
      nfcNormalized: true,
      containsSpaces: false,
      containsUnicode: false,
    },
    executionBundleManifest,
  } as const;
  const preparationScopeSha256 = deriveProbePreparationScopeDigest(contextDraft);
  const contextFields = {
    ...contextDraft,
    preparationScopeSha256,
    preparationClaimReceiptSha256: deriveProbePreparationClaimReceiptDigest(preparationScopeSha256),
  } satisfies Omit<PreparedProbeContext, "preflightSha256">;
  return {
    ...contextFields,
    preflightSha256: derivePreparedProbeContextDigest(contextFields),
  } satisfies PreparedProbeContext;
}

function signedControllerReceipt({
  prepared,
  nativeSeal,
  rowId,
  variantId,
  runAuthorization,
  finalizationIntent,
  quiescenceLease,
  privateKey,
}: {
  prepared: PreparedProbeContext;
  nativeSeal: NativeEvidenceSeal;
  rowId: string;
  variantId: string;
  runAuthorization: ProbeRunAuthorization;
  finalizationIntent: ProbeFinalizationIntent;
  quiescenceLease: ProbeQuiescenceLeaseReceipt;
  privateKey: KeyObject;
}) {
  const fields: Omit<ControllerEvidenceSealReceipt, "receiptSha256" | "signatureBase64"> = {
    schemaVersion: 1,
    kind: "windows-host-probe-controller-evidence-seal-receipt",
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId,
    variantId,
    runAuthorizationSha256: runAuthorization.authorizationSha256,
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    quiescenceLeaseId: quiescenceLease.leaseId,
    quiescenceLeaseEpoch: quiescenceLease.leaseEpoch,
    quiescenceRenewalSequence: quiescenceLease.renewalSequence,
    quiescenceLeaseReceiptSha256: quiescenceLease.receiptSha256,
    quiescenceActorSetSha256: quiescenceLease.actorSetSha256,
    quiescenceAcquiredAt: quiescenceLease.acquiredAt,
    quiescenceLeaseExpiresAt: quiescenceLease.expiresAt,
    evidenceRootObjectIdentitySha256: digest(nativeSeal.rootObjectIdentity),
    nativeSealSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-native-evidence-seal.v1",
      seal: nativeSeal,
    }),
    actorsQuiesced: true,
    capturedAt: "2026-08-06T10:00:02.000Z",
    controllerIdentitySha256: prepared.executionBundleManifest.controller.identitySha256,
    controllerPublicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
    controllerVersion: prepared.executionBundleManifest.controller.version,
    signatureAlgorithm: "Ed25519",
  };
  const receiptSha256 = deriveControllerEvidenceSealReceiptDigest(fields);
  return {
    ...fields,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), privateKey).toString("base64"),
    receiptSha256,
  } satisfies ControllerEvidenceSealReceipt;
}

function makeFinalizationIntent({
  prepared,
  runAuthorization,
  runAuthorizationClaim,
  rowId,
  variantId,
  chainId,
}: {
  prepared: PreparedProbeContext;
  runAuthorization: ProbeRunAuthorization;
  runAuthorizationClaim: ProbeRunAuthorizationClaimReceipt;
  rowId: string;
  variantId: string;
  chainId: string;
}): ProbeFinalizationIntent {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-finalization-intent" as const,
    campaignId: prepared.campaignId,
    manifestSha256: prepared.manifestSha256,
    candidateSha256: prepared.candidateSha256,
    runAuthorizationSha256: runAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: runAuthorizationClaim.receiptSha256,
    campaignRunId: prepared.campaignRunId,
    executionRunId: prepared.executionRunId,
    executionBundleId: prepared.executionBundleId,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    attemptId: prepared.attemptId,
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId,
    variantId,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
    continuationChainIds: [chainId],
    upstreamSelectionDigests: [],
    startedAt: "2026-08-06T10:00:00.000Z",
  };
  return {
    ...unsigned,
    finalizationOperationSha256: deriveProbeFinalizationOperationDigest(unsigned),
  };
}

function signedLeaseReceipt({
  prepared,
  finalizationIntent,
  renewalSequence,
  privateKey,
}: {
  prepared: PreparedProbeContext;
  finalizationIntent: ProbeFinalizationIntent;
  renewalSequence: number;
  privateKey: KeyObject;
}): ProbeQuiescenceLeaseReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-controller-quiescence-lease-receipt" as const,
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    runAuthorizationSha256: finalizationIntent.runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: finalizationIntent.runAuthorizationClaimReceiptSha256,
    evidenceRootObjectIdentitySha256: finalizationIntent.evidenceRootObjectIdentitySha256,
    leaseId: "finalization-lease-one",
    leaseEpoch: 1,
    renewalSequence,
    actorSetSha256: labeledDigest("quiesced-evidence-producers"),
    acquiredAt: "2026-08-06T10:00:00.500Z",
    expiresAt:
      renewalSequence === 0
        ? "2026-08-06T10:05:00.000Z"
        : renewalSequence === 1
          ? "2026-08-06T10:10:00.000Z"
          : "2026-08-06T10:15:00.000Z",
    state: "active" as const,
    controllerIdentitySha256: prepared.executionBundleManifest.controller.identitySha256,
    controllerPublicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
    controllerVersion: prepared.executionBundleManifest.controller.version,
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveProbeQuiescenceLeaseReceiptDigest(unsigned);
  return {
    ...unsigned,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), privateKey).toString("base64"),
    receiptSha256,
  };
}

function signedCompletionReceipt({
  prepared,
  finalizationIntent,
  leaseReceipt,
  evidenceCaptureReceiptSha256,
  segmentProof,
  privateKey,
}: {
  prepared: PreparedProbeContext;
  finalizationIntent: ProbeFinalizationIntent;
  leaseReceipt: ProbeQuiescenceLeaseReceipt;
  evidenceCaptureReceiptSha256: string;
  segmentProof: ProbeSegmentProof;
  privateKey: KeyObject;
}): ProbeQuiescenceCompletionReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-controller-quiescence-completion-receipt" as const,
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    leaseId: leaseReceipt.leaseId,
    leaseEpoch: leaseReceipt.leaseEpoch,
    leaseReceiptSha256: leaseReceipt.receiptSha256,
    evidenceCaptureReceiptSha256,
    ...segmentProof,
    completedAt: "2026-08-06T10:00:04.000Z",
    state: "completed" as const,
    controllerIdentitySha256: prepared.executionBundleManifest.controller.identitySha256,
    controllerPublicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
    controllerVersion: prepared.executionBundleManifest.controller.version,
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveProbeQuiescenceCompletionReceiptDigest(unsigned);
  return {
    ...unsigned,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), privateKey).toString("base64"),
    receiptSha256,
  };
}

function signedAbandonmentReceipt({
  prepared,
  finalizationIntent,
  leaseReceipt,
  reasonCode,
  privateKey,
}: {
  prepared: PreparedProbeContext;
  finalizationIntent: ProbeFinalizationIntent;
  leaseReceipt: ProbeQuiescenceLeaseReceipt;
  reasonCode: string;
  privateKey: KeyObject;
}) {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-controller-quiescence-abandonment-receipt" as const,
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    leaseId: leaseReceipt.leaseId,
    leaseEpoch: leaseReceipt.leaseEpoch,
    leaseReceiptSha256: leaseReceipt.receiptSha256,
    reasonCode,
    abandonedAt: "2026-08-06T10:00:04.000Z",
    state: "abandoned" as const,
    controllerIdentitySha256: prepared.executionBundleManifest.controller.identitySha256,
    controllerPublicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
    controllerVersion: prepared.executionBundleManifest.controller.version,
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveProbeQuiescenceAbandonmentReceiptDigest(unsigned);
  return {
    ...unsigned,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), privateKey).toString("base64"),
    receiptSha256,
  };
}

function transcriptObservation(
  factKey: string,
  value: ProbeTranscriptFactValue,
): ProbeTranscriptObservation {
  if (value === null) return { factKey, valueKind: "null", value };
  if (Array.isArray(value)) {
    const elementType = typeof value[0];
    if (elementType === "boolean") return { factKey, valueKind: "boolean-array", value };
    if (elementType === "number") return { factKey, valueKind: "number-array", value };
    return { factKey, valueKind: "string-array", value };
  }
  if (typeof value === "boolean") return { factKey, valueKind: "boolean", value };
  if (typeof value === "number") return { factKey, valueKind: "number", value };
  return { factKey, valueKind: "string", value };
}

function signedSourceTranscriptReceipt({
  sourceTranscript,
  prepared,
  privateKey,
}: {
  sourceTranscript: ProbeSourceTranscript;
  prepared: PreparedProbeContext;
  privateKey: KeyObject;
}): ProbeControllerSourceTranscriptReceipt {
  const controller = prepared.executionBundleManifest.controller;
  const fields: Omit<ProbeControllerSourceTranscriptReceipt, "signatureBase64" | "receiptSha256"> =
    {
      schemaVersion: 1,
      kind: "windows-host-probe-controller-source-transcript-receipt",
      sourceTranscriptSha256: hashProbeCanonicalJson(sourceTranscript),
      bindingSha256: hashProbeCanonicalJson({
        domain: "enduragent.windows-host-probe-source-transcript-binding.v1",
        binding: sourceTranscript.binding,
      }),
      producerKind: sourceTranscript.producer.kind,
      producerIdentitySha256: sourceTranscript.producer.identitySha256,
      nativeTranscriptSetSha256: hashProbeCanonicalJson({
        domain: "enduragent.windows-host-probe-native-transcript-set.v1",
        nativeTranscripts: sourceTranscript.nativeTranscripts,
      }),
      controllerIdentitySha256: controller.identitySha256,
      controllerPublicKeySha256: controller.publicKeySha256,
      controllerVersion: controller.version,
      signatureAlgorithm: "Ed25519",
    };
  const receiptSha256 = deriveControllerSourceTranscriptReceiptDigest(fields);
  return {
    ...fields,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), privateKey).toString("base64"),
    receiptSha256,
  };
}

async function setupFinalization({
  alteredVerifier = false,
  tamperSourceAfterSigning = false,
  includeObserverTranscript = false,
  omitNativeManifestDigestCandidateSource = false,
  nativeCandidateDigestOverride = null,
  nativeManifestSha256Override = null,
  controllerActionSubstitution = null,
}: {
  alteredVerifier?: boolean;
  tamperSourceAfterSigning?: boolean;
  includeObserverTranscript?: boolean;
  omitNativeManifestDigestCandidateSource?: boolean;
  nativeCandidateDigestOverride?: string | null;
  nativeManifestSha256Override?: string | null;
  controllerActionSubstitution?: "cross-work" | "repetition" | "producer-action" | null;
} = {}) {
  const store = await createStore();
  const [
    currentVerifierBytes,
    contractBytes,
    transcriptBytes,
    nativeClientBytes,
    nativeManifestDigestBytes,
  ] = await Promise.all([
    readFile(new URL("../scripts/windows-host-falsifier/probe-registry.mjs", import.meta.url)),
    readFile(new URL("../scripts/windows-host-falsifier/probe-contract.mjs", import.meta.url)),
    readFile(new URL("../scripts/windows-host-falsifier/probe-transcript.mjs", import.meta.url)),
    readFile(new URL("../scripts/windows-host-falsifier/native-client.mjs", import.meta.url)),
    readFile(
      new URL("../scripts/windows-host-falsifier/native-manifest-digest.mjs", import.meta.url),
    ),
  ]);
  const verifierBytes = alteredVerifier
    ? Buffer.from(
        currentVerifierBytes
          .toString("utf8")
          .replace("win32-file-identity-home-key-v1", "isolated-file-identity-home-key-v1"),
        "utf8",
      )
    : currentVerifierBytes;
  const candidate = makeCandidate(
    digest(verifierBytes),
    digest(contractBytes),
    digest(transcriptBytes),
    digest(nativeClientBytes),
    digest(nativeManifestDigestBytes),
    { includeNativeManifestDigest: !omitNativeManifestDigestCandidateSource },
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ format: "der", type: "spki" });
  const operatorKeys = generateKeyPairSync("ed25519");
  const operatorPublicKeyBytes = operatorKeys.publicKey.export({
    format: "der",
    type: "spki",
  });
  const asciiGuestBytes = Buffer.from("sanitized ascii guest evidence");
  const unicodeGuestBytes = Buffer.from("sanitized unicode guest evidence");
  const controllerBytes = Buffer.from("sanitized controller evidence");
  const attestation = makeAttestation(publicKeyBytes, {
    guestAscii: {
      path: "attestations/win11-floor-ascii-guest.json",
      sha256: digest(asciiGuestBytes),
    },
    guestUnicode: {
      path: "attestations/win11-floor-spaces-unicode-guest.json",
      sha256: digest(unicodeGuestBytes),
    },
    controller: {
      path: "attestations/win11-floor-controller.json",
      sha256: digest(controllerBytes),
    },
  });
  await writeBytes(store, attestedGuestEvidence(attestation).path, asciiGuestBytes);
  await writeBytes(
    store,
    attestedGuestEvidence(attestation, "spaces-unicode").path,
    unicodeGuestBytes,
  );
  await writeBytes(store, attestation.controllerEvidence.path, controllerBytes);
  await writeBytes(store, attestation.controller.publicKeyArtifact.path, publicKeyBytes);

  const rootObjectIdentity = "volume-identity:file-identity:evidence-root";
  const nativeSeal = await makeNativeSeal(
    store,
    [attestedGuestEvidence(attestation).path],
    rootObjectIdentity,
  );
  const runAuthorization = makeRunAuthorization({
    candidate,
    attestation,
    operatorPrivateKey: operatorKeys.privateKey,
  });
  const runAuthorizationClaim = makeRunAuthorizationClaim({
    runAuthorization,
    attestation,
    evidenceRootObjectIdentitySha256: digest(nativeSeal.rootObjectIdentity),
    operatorPublicKeyBytes,
    controllerPrivateKey: privateKey,
  });
  const prepared = makePreparedContext({
    candidate,
    attestation,
    evidenceRootObjectIdentitySha256: digest(nativeSeal.rootObjectIdentity),
    runAuthorization,
    runAuthorizationClaim,
  });
  const controllerActionFixture = controllerActionSubstitution !== null;
  const rowId = controllerActionFixture ? "F-06" : "F-01";
  const variantId = controllerActionFixture
    ? "f06-baseline-after-flush-share-allows-replace"
    : "f01-ordinary-absolute-path";
  const retainedVerifier = await loadRetainedProbeVerifier({
    registrySourceBytes: verifierBytes,
    contractSourceBytes: contractBytes,
    transcriptSourceBytes: transcriptBytes,
    nativeClientSourceBytes: nativeClientBytes,
    nativeManifestDigestSourceBytes: nativeManifestDigestBytes,
  });
  const definition = await retainedVerifier.getDefinition(rowId, variantId);
  const transcriptFactDefinition = await retainedVerifier.getTranscriptFactDefinition(
    rowId,
    variantId,
  );
  const paths = probeSegmentArtifactPaths({
    environmentId: prepared.environmentId,
    pathProfileId: prepared.pathProfileId,
    rowId,
    variantId,
  });
  const facts = controllerActionFixture
    ? {
        context: "baseline",
        checkpoint: "after-flush",
        shareMode: "share-allows-replace",
        replaceDisposition: "committed",
        win32Error: null,
        reasonCode: null,
        oldRecordSha256: labeledDigest("old-record"),
        candidateRecordSha256: labeledDigest("candidate-record"),
        observedRecordSha256s: [labeledDigest("candidate-record")],
        partialRecordCount: 0,
        missingRecordCount: 0,
        readerSampleCount: 1,
        remainingOwnedTempCount: 0,
        retryCount: 0,
        elapsedMs: 1,
        defenderScanObserved: false,
        processCrashObserved: false,
        rebootObserved: false,
      }
    : {
        pathTopology: "ordinary-absolute-path",
        processRole: "main",
        lifecycle: "same-process",
        credentialReadAttempted: false,
        canonicalIdentitySha256: labeledDigest("canonical-home"),
        comparisonIdentitySha256: null,
        localPathSha256: labeledDigest("local-path"),
        volumeIdentitySha256: labeledDigest("volume-identity"),
        volumeFileSystem: "NTFS",
        volumeDriveType: "fixed",
        win32Error: null,
        reasonCode: null,
      };
  const captureComplete = true;
  const availability = { status: "available", reason: null } as const;
  const nativeRequest = { relativePath: "homes\\home-a" };
  const nativeBindingFields = {
    campaignRunId: prepared.campaignRunId,
    candidateSha256: prepared.candidateSha256,
    preflightSha256: prepared.preflightSha256,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    nativeHelperArtifactPath: prepared.executionBundleManifest.binaries.nativeHelper.path,
    nativeHelperSha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
    evidenceRootObjectIdentitySha256: digest(rootObjectIdentity),
    nativeCandidateDigest:
      nativeCandidateDigestOverride ??
      prepared.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest,
    nativeManifestSha256:
      nativeManifestSha256Override ??
      prepared.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256,
    nativeSessionId: "native-session-one",
    runRootIdentity: rootObjectIdentity,
  } as const;
  const startupRequestId = "startup-request-one";
  const startupRequestContext = {
    campaignRunId: nativeBindingFields.campaignRunId,
    candidateSha256: nativeBindingFields.candidateSha256,
    preflightSha256: nativeBindingFields.preflightSha256,
    executionBundleManifestSha256: nativeBindingFields.executionBundleManifestSha256,
    nativeCandidateDigest: nativeBindingFields.nativeCandidateDigest,
    nativeManifestSha256: nativeBindingFields.nativeManifestSha256,
    nativeHelperSha256: nativeBindingFields.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: nativeBindingFields.evidenceRootObjectIdentitySha256,
    nativeSessionId: nativeBindingFields.nativeSessionId,
    operationId: "startup-operation-one",
  } as const;
  const startupHandshake = {
    protocolVersion: 1,
    kind: "response",
    requestId: startupRequestId,
    command: "native-binding-check",
    context: {
      ...startupRequestContext,
      requestFrameSha256: compactCanonicalDigest({
        protocolVersion: 1,
        requestId: startupRequestId,
        command: "native-binding-check",
        context: startupRequestContext,
        request: {},
      }),
      runRootIdentity: nativeBindingFields.runRootIdentity,
    },
    ok: true,
    result: {
      ready: true,
      processId: 1234,
      nativeHelperSha256: nativeBindingFields.nativeHelperSha256,
      runRootIdentity: nativeBindingFields.runRootIdentity,
      evidenceRootObjectIdentitySha256: nativeBindingFields.evidenceRootObjectIdentitySha256,
    },
  } as const;
  const nativeTranscriptPayload = {
    schemaVersion: 1,
    kind: "windows-host-native-command-transcript",
    binding: {
      ...nativeBindingFields,
      startupHandshake,
      startupHandshakeSha256: compactCanonicalDigest(startupHandshake),
    },
    records: [] as Readonly<Record<string, unknown>>[],
    termination: { mode: "clean-eof", code: 0, signal: null },
  } as const;
  const nativeRequestContext = {
    campaignRunId: nativeTranscriptPayload.binding.campaignRunId,
    candidateSha256: nativeTranscriptPayload.binding.candidateSha256,
    preflightSha256: nativeTranscriptPayload.binding.preflightSha256,
    executionBundleManifestSha256: nativeTranscriptPayload.binding.executionBundleManifestSha256,
    nativeCandidateDigest: nativeTranscriptPayload.binding.nativeCandidateDigest,
    nativeManifestSha256: nativeTranscriptPayload.binding.nativeManifestSha256,
    nativeHelperSha256: nativeTranscriptPayload.binding.nativeHelperSha256,
    evidenceRootObjectIdentitySha256:
      nativeTranscriptPayload.binding.evidenceRootObjectIdentitySha256,
    nativeSessionId: nativeTranscriptPayload.binding.nativeSessionId,
    operationId: "home-identity-one",
  };
  const nativeResult = {
    canonicalHomeId: "volume-identity:file-identity:home-a",
    objectIdentity: "volume-identity:file-identity:home-a",
    volumeIdentity: "volume-identity",
    finalPathSha256: labeledDigest("native-final-path"),
    fileSystem: "NTFS",
    driveType: "fixed",
    reparseTag: 0,
    linkCount: 1,
  };
  const nativeCommandRecord = {
    kind: "command",
    sequence: 1,
    requestId: "home-request-one",
    command: "home-identity",
    operationId: nativeRequestContext.operationId,
    requestFrameSha256: compactCanonicalDigest({
      protocolVersion: 1,
      requestId: "home-request-one",
      command: "home-identity",
      context: nativeRequestContext,
      request: nativeRequest,
    }),
    nativeRequestFrameSha256: compactCanonicalDigest({
      protocolVersion: 1,
      requestId: "home-request-one",
      command: "home-identity",
      context: nativeRequestContext,
      request: nativeRequest,
    }),
    requestFrameVerification: "recomputed",
    responseFrameSha256: compactCanonicalDigest({
      protocolVersion: 1,
      kind: "response",
      requestId: "home-request-one",
      command: "home-identity",
      context: {
        ...nativeRequestContext,
        requestFrameSha256: compactCanonicalDigest({
          protocolVersion: 1,
          requestId: "home-request-one",
          command: "home-identity",
          context: nativeRequestContext,
          request: nativeRequest,
        }),
        runRootIdentity: nativeTranscriptPayload.binding.runRootIdentity,
      },
      ok: true,
      result: nativeResult,
    }),
    ok: true,
    request: nativeRequest,
    result: nativeResult,
  } as const;
  nativeTranscriptPayload.records.push(nativeCommandRecord);
  const nativeTranscript = {
    ...nativeTranscriptPayload,
    transcriptSha256: compactCanonicalDigest({
      domain: "enduragent.windows-host-native-command-transcript.v1",
      transcript: nativeTranscriptPayload,
    }),
  } as const;
  const observerBindingFields = {
    ...nativeBindingFields,
    nativeSessionId: "native-session-two",
  } as const;
  const observerStartupRequestContext = {
    campaignRunId: observerBindingFields.campaignRunId,
    candidateSha256: observerBindingFields.candidateSha256,
    preflightSha256: observerBindingFields.preflightSha256,
    executionBundleManifestSha256: observerBindingFields.executionBundleManifestSha256,
    nativeCandidateDigest: observerBindingFields.nativeCandidateDigest,
    nativeManifestSha256: observerBindingFields.nativeManifestSha256,
    nativeHelperSha256: observerBindingFields.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: observerBindingFields.evidenceRootObjectIdentitySha256,
    nativeSessionId: observerBindingFields.nativeSessionId,
    operationId: "startup-operation-two",
  } as const;
  const observerStartupHandshake = {
    protocolVersion: 1,
    kind: "response",
    requestId: "startup-request-two",
    command: "native-binding-check",
    context: {
      ...observerStartupRequestContext,
      requestFrameSha256: compactCanonicalDigest({
        protocolVersion: 1,
        requestId: "startup-request-two",
        command: "native-binding-check",
        context: observerStartupRequestContext,
        request: {},
      }),
      runRootIdentity: observerBindingFields.runRootIdentity,
    },
    ok: true,
    result: {
      ready: true,
      processId: 1235,
      nativeHelperSha256: observerBindingFields.nativeHelperSha256,
      runRootIdentity: observerBindingFields.runRootIdentity,
      evidenceRootObjectIdentitySha256: observerBindingFields.evidenceRootObjectIdentitySha256,
    },
  } as const;
  const observerTranscriptPayload = {
    schemaVersion: 1,
    kind: "windows-host-native-command-transcript",
    binding: {
      ...observerBindingFields,
      startupHandshake: observerStartupHandshake,
      startupHandshakeSha256: compactCanonicalDigest(observerStartupHandshake),
    },
    records: [] as Readonly<Record<string, unknown>>[],
    termination: { mode: "clean-eof", code: 0, signal: null },
  } as const;
  const observerRequest = { relativePath: "homes\\home-b" };
  const observerRequestContext = {
    campaignRunId: observerTranscriptPayload.binding.campaignRunId,
    candidateSha256: observerTranscriptPayload.binding.candidateSha256,
    preflightSha256: observerTranscriptPayload.binding.preflightSha256,
    executionBundleManifestSha256: observerTranscriptPayload.binding.executionBundleManifestSha256,
    nativeCandidateDigest: observerTranscriptPayload.binding.nativeCandidateDigest,
    nativeManifestSha256: observerTranscriptPayload.binding.nativeManifestSha256,
    nativeHelperSha256: observerTranscriptPayload.binding.nativeHelperSha256,
    evidenceRootObjectIdentitySha256:
      observerTranscriptPayload.binding.evidenceRootObjectIdentitySha256,
    nativeSessionId: observerTranscriptPayload.binding.nativeSessionId,
    operationId: "home-identity-two",
  };
  const observerResult = {
    ...nativeResult,
    canonicalHomeId: "volume-identity:file-identity:home-b",
    objectIdentity: "volume-identity:file-identity:home-b",
    finalPathSha256: labeledDigest("observer-final-path"),
  };
  const observerRequestFrameSha256 = compactCanonicalDigest({
    protocolVersion: 1,
    requestId: "home-request-two",
    command: "home-identity",
    context: observerRequestContext,
    request: observerRequest,
  });
  observerTranscriptPayload.records.push({
    kind: "command",
    sequence: 1,
    requestId: "home-request-two",
    command: "home-identity",
    operationId: observerRequestContext.operationId,
    requestFrameSha256: observerRequestFrameSha256,
    nativeRequestFrameSha256: observerRequestFrameSha256,
    requestFrameVerification: "recomputed",
    responseFrameSha256: compactCanonicalDigest({
      protocolVersion: 1,
      kind: "response",
      requestId: "home-request-two",
      command: "home-identity",
      context: {
        ...observerRequestContext,
        requestFrameSha256: observerRequestFrameSha256,
        runRootIdentity: observerTranscriptPayload.binding.runRootIdentity,
      },
      ok: true,
      result: observerResult,
    }),
    ok: true,
    request: observerRequest,
    result: observerResult,
  });
  const observerTranscript = {
    ...observerTranscriptPayload,
    transcriptSha256: compactCanonicalDigest({
      domain: "enduragent.windows-host-native-command-transcript.v1",
      transcript: observerTranscriptPayload,
    }),
  } as const;
  const nativeTranscripts = [
    {
      transcriptSha256: nativeTranscript.transcriptSha256,
      binding: nativeTranscript.binding,
    },
    ...(includeObserverTranscript
      ? [
          {
            transcriptSha256: observerTranscript.transcriptSha256,
            binding: observerTranscript.binding,
          },
        ]
      : []),
  ];
  let retainedControllerActionAttestation = null;
  let retainedControllerActionAttestationPath = null;
  if (controllerActionFixture) {
    const scenario = getProbeScenarioDefinition(rowId, variantId);
    const producerAction = scenario.actions.find(
      ({ actionId }) => actionId === "capture-atomic-replacement-campaign",
    );
    if (producerAction === undefined) throw new Error("controller producer action is missing");
    const workItem = getProbeRunWorkItem({
      environmentId: prepared.environmentId,
      pathProfileId: prepared.pathProfileId,
      rowId,
      variantId,
    });
    const expectedCoordinate = {
      campaignRunId: prepared.campaignRunId,
      executionRunId: prepared.executionRunId,
      attemptId: prepared.attemptId,
      workId: workItem.workId,
      environmentId: prepared.environmentId,
      pathProfileId: prepared.pathProfileId,
      rowId,
      variantId,
      repetition: null,
    } as const;
    const substitutedCoordinate =
      controllerActionSubstitution === "cross-work"
        ? { ...expectedCoordinate, workId: "work-foreign" }
        : controllerActionSubstitution === "repetition"
          ? { ...expectedCoordinate, repetition: 2 }
          : expectedCoordinate;
    const producerActionId =
      controllerActionSubstitution === "producer-action"
        ? "run-replacement-operation"
        : producerAction.actionId;
    retainedControllerActionAttestation = createProbeControllerActionAttestation({
      candidateSha256: prepared.candidateSha256,
      executionBundleId: prepared.executionBundleId,
      executionBundleManifestSha256: prepared.executionBundleManifestSha256,
      runAuthorizationClaimReceiptSha256: prepared.runAuthorizationClaimReceiptSha256,
      coordinate: substitutedCoordinate,
      scenarioPlanSha256: scenario.planSha256,
      producerActionId,
      operation: {
        operationId: "operation-controller-capture",
        kind: "scenario-action",
        sequence: producerAction.sequence,
      },
      runtimeActionIntentSha256: labeledDigest("controller-runtime-action-intent"),
      execution: {
        actor: "external-controller",
        operation: producerAction.operation,
        locus: "controller-host",
        driverId: "controller-finalizer-fixture",
        disruptive: false,
        nativeTranscriptRequired: true,
        actorSelector: { kind: "fixed", role: "controller" },
      },
      expectedActor: {
        role: "controller",
        identitySource: "controller.identitySha256",
        identitySha256: prepared.executionBundleManifest.controller.identitySha256,
      },
      broker: null,
      observerCommands: [
        {
          transcriptSha256: nativeTranscript.transcriptSha256,
          sequence: nativeCommandRecord.sequence,
          commandId: nativeCommandRecord.command,
          requestFrameSha256: nativeCommandRecord.requestFrameSha256,
          responseFrameSha256: nativeCommandRecord.responseFrameSha256,
          ok: nativeCommandRecord.ok,
        },
      ],
    });
    retainedControllerActionAttestationPath = probeControllerActionAttestationPath({
      coordinate: expectedCoordinate,
      producerActionId: producerAction.actionId,
    });
    await writeBytes(
      store,
      retainedControllerActionAttestationPath,
      canonicalProbeJson(retainedControllerActionAttestation),
    );
  }
  const sourceTranscript: ProbeSourceTranscript = {
    schemaVersion: 1,
    kind: "windows-host-probe-source-transcript",
    producer: controllerActionFixture
      ? {
          kind: "external-controller",
          identitySha256: prepared.executionBundleManifest.controller.identitySha256,
        }
      : {
          kind: "native-helper",
          identitySha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
        },
    binding: {
      campaignId: prepared.campaignId,
      manifestSha256: prepared.manifestSha256,
      candidateSha256: prepared.candidateSha256,
      labAttestationSha256: prepared.labAttestationSha256,
      campaignRunId: prepared.campaignRunId,
      executionRunId: prepared.executionRunId,
      executionBundleId: prepared.executionBundleId,
      executionBundleManifestSha256: prepared.executionBundleManifestSha256,
      attemptId: prepared.attemptId,
      preflightSha256: prepared.preflightSha256,
      preparationScopeSha256: prepared.preparationScopeSha256,
      environmentId: prepared.environmentId,
      pathProfileId: prepared.pathProfileId,
      vmSnapshotId: prepared.vmSnapshotId,
      bootIdSha256: prepared.bootIdSha256,
      runnerSessionIdSha256: prepared.runnerSessionIdSha256,
      rootPathSha256: prepared.pathProfileObservation.rootPathSha256,
      evidenceRootObjectIdentitySha256:
        prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
      volumeIdSha256: prepared.pathProfileObservation.volumeIdSha256,
      rowId,
      variantId,
      verifierDefinitionSha256: definition.definitionSha256,
      verifierSourceSha256: digest(verifierBytes),
    },
    nativeTranscripts,
    observerNativeTranscriptSha256s: controllerActionFixture
      ? [nativeTranscript.transcriptSha256]
      : includeObserverTranscript
        ? [observerTranscript.transcriptSha256]
        : [],
    captureComplete,
    availability,
    commandEvents: transcriptFactDefinition.commands.map((command, index) => ({
      sequence: index + 1,
      producerKind: controllerActionFixture ? "external-controller" : "native-helper",
      actionAttestationSha256: controllerActionFixture
        ? retainedControllerActionAttestation!.attestationSha256
        : null,
      commandId: command.commandId,
      requestSha256: controllerActionFixture
        ? labeledDigest("controller-command-request")
        : nativeCommandRecord.requestFrameSha256,
      responseSha256: controllerActionFixture
        ? labeledDigest("controller-command-response")
        : nativeCommandRecord.responseFrameSha256,
      nativeTranscriptSha256s: controllerActionFixture ? [] : [nativeTranscript.transcriptSha256],
      observations: command.factKeys.map((factKey) => {
        const value = facts[factKey as keyof typeof facts];
        if (value === undefined) throw new Error(`missing fact fixture: ${factKey}`);
        return transcriptObservation(factKey, value);
      }),
    })),
  };
  const sourceTranscriptReceipt = signedSourceTranscriptReceipt({
    sourceTranscript,
    prepared,
    privateKey,
  });
  const retainedSourceTranscript = tamperSourceAfterSigning
    ? {
        ...sourceTranscript,
        commandEvents: sourceTranscript.commandEvents.map((event, index) =>
          index === 0 ? { ...event, responseSha256: labeledDigest("unsigned-tamper") } : event,
        ),
      }
    : sourceTranscript;
  const sourceTranscriptBytes = Buffer.from(canonicalProbeJson(retainedSourceTranscript), "utf8");
  await writeBytes(
    store,
    `${paths.nativeTranscripts}/${nativeTranscript.transcriptSha256}.json`,
    canonicalProbeJson(nativeTranscript),
  );
  if (includeObserverTranscript) {
    await writeBytes(
      store,
      `${paths.nativeTranscripts}/${observerTranscript.transcriptSha256}.json`,
      canonicalProbeJson(observerTranscript),
    );
  }
  await writeBytes(store, paths.sourceTranscript, sourceTranscriptBytes);
  await writeBytes(
    store,
    paths.sourceTranscriptReceipt,
    canonicalProbeJson(sourceTranscriptReceipt),
  );
  const chainId = "f01-ordinary-chain";
  await initializeContinuation({
    store,
    scope: {
      campaignId: prepared.campaignId,
      manifestSha256: prepared.manifestSha256,
      candidateSha256: prepared.candidateSha256,
      labAttestationSha256: prepared.labAttestationSha256,
      campaignRunId: prepared.campaignRunId,
      executionRunId: prepared.executionRunId,
      executionBundleId: prepared.executionBundleId,
      executionBundleManifestSha256: prepared.executionBundleManifestSha256,
      environmentId: prepared.environmentId,
      pathProfileId: prepared.pathProfileId,
      rowId,
      variantId,
      attemptId: prepared.attemptId,
      vmSnapshotId: prepared.vmSnapshotId,
      repetition: 1,
      chainId,
    },
    now: () => new Date("2026-08-06T10:00:00.000Z"),
  });
  await appendContinuation({
    store,
    chainId,
    operationId: "native-scenario-completed",
    payload: {
      event: "native-scenario-completed",
      evidenceSha256: digest(sourceTranscriptBytes),
    },
    now: () => new Date("2026-08-06T10:00:01.000Z"),
  });
  await closeContinuation({
    store,
    chainId,
    now: () => new Date("2026-08-06T10:00:02.000Z"),
  });
  const repositoryState: ProbeRepositoryState = {
    repositoryCommit: candidate.repositoryCommit,
    repositoryDirty: false,
    sourceHashes: candidate.sourceHashes,
  };
  const finalizationIntent = makeFinalizationIntent({
    prepared,
    runAuthorization,
    runAuthorizationClaim,
    rowId,
    variantId,
    chainId,
  });
  return {
    store,
    verifierBytes,
    contractBytes,
    transcriptBytes,
    nativeClientBytes,
    nativeManifestDigestBytes,
    candidate,
    attestation,
    prepared,
    runAuthorization,
    runAuthorizationClaim,
    nativeSeal,
    publicKeyBytes,
    repositoryState,
    rowId,
    variantId,
    chainId,
    finalizationIntent,
    privateKey,
    rootObjectIdentity,
    retainedControllerActionAttestation,
    retainedControllerActionAttestationPath,
  };
}

type FinalizerFixture = Awaited<ReturnType<typeof setupFinalization>>;

function makeControllerAdapters(
  fixture: FinalizerFixture,
  overrides: Partial<ProbeFinalizerAdapters> = {},
  events: string[] = [],
): ProbeFinalizerAdapters {
  const leases = new Map<number, ProbeQuiescenceLeaseReceipt>();
  let currentSequence = 0;
  let completionReceipt: Awaited<
    ReturnType<ProbeFinalizerAdapters["completeEvidenceQuiescence"]>
  > | null = null;
  const getLease = (sequence: number) => {
    let receipt = leases.get(sequence);
    if (receipt === undefined) {
      receipt = signedLeaseReceipt({
        prepared: fixture.prepared,
        finalizationIntent: fixture.finalizationIntent,
        renewalSequence: sequence,
        privateKey: fixture.privateKey,
      });
      leases.set(sequence, receipt);
    }
    return receipt;
  };
  const adapters: ProbeFinalizerAdapters = {
    readRepositoryState: async () => {
      events.push("repository-read");
      return fixture.repositoryState;
    },
    readVerifierSource: async () => fixture.verifierBytes,
    readContractSource: async () => fixture.contractBytes,
    readTranscriptSource: async () => fixture.transcriptBytes,
    readNativeClientSource: async () => fixture.nativeClientBytes,
    readNativeManifestDigestSource: async () => fixture.nativeManifestDigestBytes,
    recoverOrAcquireEvidenceQuiescence: async () => {
      events.push("lease-acquired");
      return {
        acquisitionReceipt: getLease(0),
        leaseReceipt: getLease(currentSequence),
        completionReceipt,
      };
    },
    renewEvidenceQuiescence: async ({ purpose }) => {
      events.push(`lease-renewed-${purpose}`);
      const expectedSequence = purpose === "capture" ? 1 : 2;
      if (currentSequence > expectedSequence) return getLease(currentSequence);
      currentSequence = expectedSequence;
      return getLease(currentSequence);
    },
    captureQuiescedEvidenceSeal: async (binding) => {
      events.push("evidence-captured");
      const nativeSeal = await makeNativeSeal(
        fixture.store,
        binding.exactArtifactPaths,
        fixture.rootObjectIdentity,
      );
      return {
        nativeSeal,
        controllerReceipt: signedControllerReceipt({
          prepared: fixture.prepared,
          nativeSeal,
          rowId: fixture.rowId,
          variantId: fixture.variantId,
          runAuthorization: fixture.runAuthorization,
          finalizationIntent: binding.finalizationIntent,
          quiescenceLease: binding.quiescenceLease,
          privateKey: fixture.privateKey,
        }),
      };
    },
    completeEvidenceQuiescence: async ({
      finalizationIntent,
      leaseReceipt,
      evidenceCaptureReceiptSha256,
      segmentProof,
    }) => {
      events.push("controller-completed");
      if (completionReceipt !== null) return completionReceipt;
      const signed = signedCompletionReceipt({
        prepared: fixture.prepared,
        finalizationIntent,
        leaseReceipt,
        evidenceCaptureReceiptSha256,
        segmentProof,
        privateKey: fixture.privateKey,
      });
      completionReceipt = signed;
      return signed;
    },
    abandonEvidenceQuiescence: async ({ finalizationIntent, leaseReceipt, reasonCode }) => {
      events.push("controller-abandoned");
      return signedAbandonmentReceipt({
        prepared: fixture.prepared,
        finalizationIntent,
        leaseReceipt,
        reasonCode,
        privateKey: fixture.privateKey,
      });
    },
    now: () => new Date("2026-08-06T10:00:03.000Z"),
    monotonicNow: () => 4000,
  };
  return { ...adapters, ...overrides };
}

function finalizationOptions(fixture: FinalizerFixture, adapters: ProbeFinalizerAdapters) {
  return {
    store: fixture.store,
    preparedContext: fixture.prepared,
    candidate: fixture.candidate,
    attestation: fixture.attestation,
    runAuthorization: fixture.runAuthorization,
    runAuthorizationClaim: fixture.runAuthorizationClaim,
    rowId: fixture.rowId,
    variantId: fixture.variantId,
    continuationChainIds: [fixture.chainId],
    upstreamSelectionDigests: [],
    provenance: {
      startedAt: "2026-08-06T10:00:00.000Z",
      startedMonotonicMs: 1000,
    },
    adapters,
  } as const;
}

function signedSealFixture(fixture: FinalizerFixture, nativeSeal: NativeEvidenceSeal) {
  const captureLease = signedLeaseReceipt({
    prepared: fixture.prepared,
    finalizationIntent: fixture.finalizationIntent,
    renewalSequence: 1,
    privateKey: fixture.privateKey,
  });
  const controllerReceipt = signedControllerReceipt({
    prepared: fixture.prepared,
    nativeSeal,
    rowId: fixture.rowId,
    variantId: fixture.variantId,
    runAuthorization: fixture.runAuthorization,
    finalizationIntent: fixture.finalizationIntent,
    quiescenceLease: captureLease,
    privateKey: fixture.privateKey,
  });
  return { captureLease, controllerReceipt };
}

describe("Windows host probe finalizer", () => {
  it("mints a PASS only by rerunning the allowlisted verifier over retained facts", async () => {
    const fixture = await setupFinalization();
    const events: string[] = [];
    const result = await finalizeProbeSegment(
      finalizationOptions(fixture, makeControllerAdapters(fixture, {}, events)),
    );

    expect(result.segment.outcome).toBe("PASS");
    expect(result.segment.mechanismId).toBe("win32-file-identity-home-key-v1");
    expect(result.segment.rowClosureClaimed).toBe(false);
    expect(
      result.segment.observations.every((item) =>
        item.evidenceRef.endsWith("source-transcript.json"),
      ),
    ).toBe(true);
    expect(result.path).toContain("f01-ordinary-absolute-path/segment.json");
    expect(result.commitPath).toContain("f01-ordinary-absolute-path/segment-commit.json");
    expect(result.segment.artifactHashes).toContainEqual({
      path: retainedNativeManifestDigestPath,
      sha256: digest(fixture.nativeManifestDigestBytes),
    });
    await expect(
      fixture.store.readArtifact(retainedNativeManifestDigestPath),
    ).resolves.toMatchObject({ bytes: fixture.nativeManifestDigestBytes });
    expect(events.indexOf("lease-acquired")).toBeLessThan(events.indexOf("repository-read"));
    expect(events.indexOf("evidence-captured")).toBeLessThan(
      events.indexOf("controller-completed"),
    );

    await expect(
      verifyFinalizedProbeSegment({
        store: fixture.store,
        segmentPath: result.path,
        candidate: fixture.candidate,
        attestation: fixture.attestation,
      }),
    ).resolves.toEqual(result.segment);
    await expect(
      verifyCommittedProbeSegment({
        store: fixture.store,
        commitPath: result.commitPath,
        candidate: fixture.candidate,
        attestation: fixture.attestation,
      }),
    ).resolves.toMatchObject({ segment: result.segment, commit: result.commit });

    const unavailableAdapters: ProbeFinalizerAdapters = {
      readRepositoryState: async (): Promise<ProbeRepositoryState> => {
        throw new Error("idempotent replay must not inspect live repository state");
      },
      readVerifierSource: async (): Promise<Uint8Array> => {
        throw new Error("idempotent replay must not read live verifier source");
      },
      readContractSource: async (): Promise<Uint8Array> => {
        throw new Error("idempotent replay must not read live contract source");
      },
      readTranscriptSource: async (): Promise<Uint8Array> => {
        throw new Error("idempotent replay must not read live transcript source");
      },
      readNativeClientSource: async (): Promise<Uint8Array> => {
        throw new Error("idempotent replay must not read live native validator source");
      },
      readNativeManifestDigestSource: async (): Promise<Uint8Array> => {
        throw new Error("idempotent replay must not read live native digest helper source");
      },
      now: (): Date => {
        throw new Error("idempotent replay must not use a new wall clock");
      },
      monotonicNow: (): number => {
        throw new Error("idempotent replay must not use a new monotonic clock");
      },
      captureQuiescedEvidenceSeal: async () => {
        throw new Error("idempotent replay must not capture another evidence seal");
      },
      recoverOrAcquireEvidenceQuiescence: async () => {
        throw new Error("idempotent replay must not acquire a lease");
      },
      renewEvidenceQuiescence: async () => {
        throw new Error("idempotent replay must not renew a lease");
      },
      completeEvidenceQuiescence: async () => {
        throw new Error("idempotent replay must not complete a lease");
      },
      abandonEvidenceQuiescence: async () => {
        throw new Error("idempotent replay must not abandon a lease");
      },
    };
    await expect(
      finalizeProbeSegment(finalizationOptions(fixture, unavailableAdapters)),
    ).resolves.toEqual(result);
    const changedInvocation = finalizationOptions(fixture, unavailableAdapters);
    await expect(
      finalizeProbeSegment({
        ...changedInvocation,
        provenance: {
          startedAt: "2026-08-06T10:00:01.000Z",
          startedMonotonicMs: 1000,
        },
      }),
    ).rejects.toMatchObject({ code: "FINALIZER_SEGMENT_COLLISION" });

    const campaign = await finalizeProbeCampaign({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate: fixture.candidate,
      attestations: [fixture.attestation],
      segmentSources: [{ store: fixture.store, commitPath: result.commitPath }],
    });
    expect(campaign.authority).toBe("verified-artifact-finalizer");
    expect(campaign.status).toBe("INCONCLUSIVE");
    expect(campaign.selectionEligible).toBe(false);
  }, 15_000);

  it("replays one fact-producing native transcript with a separately classified observer", async () => {
    const fixture = await setupFinalization({ includeObserverTranscript: true });
    const result = await finalizeProbeSegment(
      finalizationOptions(fixture, makeControllerAdapters(fixture)),
    );
    const paths = probeSegmentArtifactPaths({
      environmentId: fixture.prepared.environmentId,
      pathProfileId: fixture.prepared.pathProfileId,
      rowId: fixture.rowId,
      variantId: fixture.variantId,
    });
    const sourceTranscript = JSON.parse(
      (await fixture.store.readArtifact(paths.sourceTranscript)).bytes.toString("utf8"),
    ) as ProbeSourceTranscript;

    expect(result.segment.outcome).toBe("PASS");
    expect(sourceTranscript.nativeTranscripts).toHaveLength(2);
    expect(sourceTranscript.observerNativeTranscriptSha256s).toHaveLength(1);
    expect(sourceTranscript.commandEvents[0].nativeTranscriptSha256s).toHaveLength(1);
    expect(sourceTranscript.commandEvents[0].nativeTranscriptSha256s).not.toEqual(
      sourceTranscript.nativeTranscripts.map(({ transcriptSha256 }) => transcriptSha256),
    );
    expect(sourceTranscript.commandEvents[0].nativeTranscriptSha256s).not.toEqual(
      sourceTranscript.observerNativeTranscriptSha256s,
    );
  }, 15_000);

  it("recovers a controller-completed segment when local commit publication crashes", async () => {
    const fixture = await setupFinalization();
    const adapters = makeControllerAdapters(fixture);
    let failedCommitPublication = false;
    const faultStore = {
      ...fixture.store,
      writeBytes: async (path: string, bytes: Uint8Array) => {
        if (!failedCommitPublication && path.endsWith("/segment-commit.json")) {
          failedCommitPublication = true;
          throw Object.assign(new Error("simulated commit publication crash"), { code: "EIO" });
        }
        return fixture.store.writeBytes(path, bytes);
      },
    };
    await expect(
      finalizeProbeSegment({ ...finalizationOptions(fixture, adapters), store: faultStore }),
    ).rejects.toMatchObject({ code: "EIO" });
    const result = await finalizeProbeSegment(finalizationOptions(fixture, adapters));
    await expect(
      verifyCommittedProbeSegment({
        store: fixture.store,
        commitPath: result.commitPath,
        candidate: fixture.candidate,
        attestation: fixture.attestation,
      }),
    ).resolves.toMatchObject({ segment: result.segment });
  }, 15_000);

  it("never lets a campaign consume a bare segment without its commit marker", async () => {
    const fixture = await setupFinalization();
    const result = await finalizeProbeSegment(
      finalizationOptions(fixture, makeControllerAdapters(fixture)),
    );
    await expect(
      finalizeProbeCampaign({
        manifest: PROBE_CAMPAIGN_MANIFEST,
        candidate: fixture.candidate,
        attestations: [fixture.attestation],
        segmentSources: [{ store: fixture.store, commitPath: result.path }],
      }),
    ).rejects.toBeDefined();
  }, 15_000);

  it("rejects a source transcript changed after the controller signed it", async () => {
    const fixture = await setupFinalization({ tamperSourceAfterSigning: true });
    await expect(
      finalizeProbeSegment(
        finalizationOptions(
          fixture,
          makeControllerAdapters(fixture, {
            captureQuiescedEvidenceSeal: async () => {
              throw new Error("an untrusted source transcript must fail before evidence sealing");
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_CONTROLLER_RECEIPT_BINDING" });
  });

  it.each(["cross-work", "repetition", "producer-action"] as const)(
    "rejects a retained external-controller action attestation with %s substitution",
    async (controllerActionSubstitution) => {
      const fixture = await setupFinalization({ controllerActionSubstitution });
      expect(fixture.retainedControllerActionAttestationPath).not.toBeNull();
      await expect(
        fixture.store.readArtifact(fixture.retainedControllerActionAttestationPath!),
      ).resolves.toBeDefined();
      const paths = probeSegmentArtifactPaths({
        environmentId: fixture.prepared.environmentId,
        pathProfileId: fixture.prepared.pathProfileId,
        rowId: fixture.rowId,
        variantId: fixture.variantId,
      });
      const sourceTranscript = JSON.parse(
        (await fixture.store.readArtifact(paths.sourceTranscript)).bytes.toString("utf8"),
      ) as ProbeSourceTranscript;
      expect(sourceTranscript.producer.kind).toBe("external-controller");
      expect(sourceTranscript.commandEvents[0]?.actionAttestationSha256).toBe(
        fixture.retainedControllerActionAttestation?.attestationSha256,
      );

      await expect(
        finalizeProbeSegment(
          finalizationOptions(
            fixture,
            makeControllerAdapters(fixture, {
              captureQuiescedEvidenceSeal: async () => {
                throw new Error("a substituted action attestation must fail before sealing");
              },
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "FINALIZER_ACTION_ATTESTATION" });
    },
    20_000,
  );

  it("rejects retained native transcripts from another native build identity", async () => {
    for (const override of [
      { nativeCandidateDigestOverride: labeledDigest("another-native-candidate") },
      { nativeManifestSha256Override: labeledDigest("another-native-manifest") },
    ]) {
      const fixture = await setupFinalization(override);
      await expect(
        finalizeProbeSegment(
          finalizationOptions(
            fixture,
            makeControllerAdapters(fixture, {
              captureQuiescedEvidenceSeal: async () => {
                throw new Error("a foreign native build must fail before evidence sealing");
              },
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "FINALIZER_NATIVE_TRANSCRIPT_BINDING" });
    }
  });

  it("rejects a signed seal from another row or another evidence root", async () => {
    const fixture = await setupFinalization();
    const signed = signedSealFixture(fixture, fixture.nativeSeal);
    expect(() =>
      verifyControllerEvidenceSealReceipt(signed.controllerReceipt, {
        preparedContext: fixture.prepared,
        nativeSeal: fixture.nativeSeal,
        controllerPublicKeyBytes: fixture.publicKeyBytes,
        rowId: "F-02",
        variantId: "f02-create-private-directory",
        runAuthorization: fixture.runAuthorization,
        finalizationIntent: fixture.finalizationIntent,
        quiescenceLease: signed.captureLease,
      }),
    ).toThrow(/rowId is mismatched/u);

    const wrongRoot = await makeNativeSeal(
      fixture.store,
      [attestedGuestEvidence(fixture.attestation).path],
      "another:evidence:root",
    );
    expect(() =>
      verifyControllerEvidenceSealReceipt(signed.controllerReceipt, {
        preparedContext: fixture.prepared,
        nativeSeal: wrongRoot,
        controllerPublicKeyBytes: fixture.publicKeyBytes,
        rowId: fixture.rowId,
        variantId: fixture.variantId,
        runAuthorization: fixture.runAuthorization,
        finalizationIntent: fixture.finalizationIntent,
        quiescenceLease: signed.captureLease,
      }),
    ).toThrow(/evidenceRootObjectIdentitySha256|nativeSealSha256/u);
  });

  it("rejects an exact native seal that aliases two paths to one object identity", async () => {
    const fixture = await setupFinalization();
    const signed = signedSealFixture(fixture, fixture.nativeSeal);
    const sourceSeal = await makeNativeSeal(
      fixture.store,
      [
        fixture.attestation.controllerEvidence.path,
        attestedGuestEvidence(fixture.attestation).path,
      ],
      fixture.rootObjectIdentity,
    );
    const entries = sourceSeal.entries.map((entry, index) => ({
      ...entry,
      objectIdentity: index === 0 ? entry.objectIdentity : sourceSeal.entries[0].objectIdentity,
    }));
    const framed = [
      "enduragent.windows-evidence-artifact-set-seal.v1",
      sourceSeal.rootObjectIdentity,
    ];
    for (const entry of entries) {
      framed.push(entry.path, entry.type, String(entry.bytes), entry.sha256, entry.objectIdentity);
    }
    const aliasedSeal = {
      ...sourceSeal,
      entries,
      setSha256: framedDigest(framed),
    };

    expect(() =>
      verifyControllerEvidenceSealReceipt(signed.controllerReceipt, {
        preparedContext: fixture.prepared,
        nativeSeal: aliasedSeal,
        controllerPublicKeyBytes: fixture.publicKeyBytes,
        rowId: fixture.rowId,
        variantId: fixture.variantId,
        runAuthorization: fixture.runAuthorization,
        finalizationIntent: fixture.finalizationIntent,
        quiescenceLease: signed.captureLease,
      }),
    ).toThrowError(expect.objectContaining({ code: "FINALIZER_NATIVE_SEAL" }));

    const unicodeEntry = { ...sourceSeal.entries[0], path: "attestations/évidence.json" };
    const unicodeSeal = {
      ...sourceSeal,
      entryCount: 1,
      entries: [unicodeEntry],
      totalBytes: unicodeEntry.bytes,
      setSha256: framedDigest([
        "enduragent.windows-evidence-artifact-set-seal.v1",
        sourceSeal.rootObjectIdentity,
        unicodeEntry.path,
        unicodeEntry.type,
        String(unicodeEntry.bytes),
        unicodeEntry.sha256,
        unicodeEntry.objectIdentity,
      ]),
    };
    expect(() =>
      verifyControllerEvidenceSealReceipt(signed.controllerReceipt, {
        preparedContext: fixture.prepared,
        nativeSeal: unicodeSeal,
        controllerPublicKeyBytes: fixture.publicKeyBytes,
        rowId: fixture.rowId,
        variantId: fixture.variantId,
        runAuthorization: fixture.runAuthorization,
        finalizationIntent: fixture.finalizationIntent,
        quiescenceLease: signed.captureLease,
      }),
    ).toThrowError(expect.objectContaining({ code: "FINALIZER_NATIVE_SEAL" }));
  });

  it("uses the retained candidate verifier rather than the currently imported registry", async () => {
    const fixture = await setupFinalization({ alteredVerifier: true });
    const result = await finalizeProbeSegment(
      finalizationOptions(fixture, makeControllerAdapters(fixture)),
    );

    expect(getProbeVerifierDefinition(fixture.rowId, fixture.variantId).mechanismId).toBe(
      "win32-file-identity-home-key-v1",
    );
    expect(result.segment.mechanismId).toBe("isolated-file-identity-home-key-v1");
  }, 15_000);

  it("fails closed when the live verifier source is not the candidate source", async () => {
    const fixture = await setupFinalization();
    await expect(
      finalizeProbeSegment(
        finalizationOptions(
          fixture,
          makeControllerAdapters(fixture, {
            readVerifierSource: async () => Buffer.from("different verifier"),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "FINALIZER_VERIFIER_SOURCE" });
  });

  it("fails closed when the candidate omits the native manifest digest helper", async () => {
    const fixture = await setupFinalization({
      omitNativeManifestDigestCandidateSource: true,
    });
    await expect(
      finalizeProbeSegment(finalizationOptions(fixture, makeControllerAdapters(fixture))),
    ).rejects.toMatchObject({ code: "FINALIZER_VERIFIER_SOURCE" });
  });

  it("fails closed when the live native manifest digest helper is tampered", async () => {
    const fixture = await setupFinalization();
    await expect(
      finalizeProbeSegment(
        finalizationOptions(
          fixture,
          makeControllerAdapters(fixture, {
            readNativeManifestDigestSource: async () =>
              Buffer.concat([fixture.nativeManifestDigestBytes, Buffer.from("\n// tampered\n")]),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "FINALIZER_VERIFIER_SOURCE" });
  });

  it("rejects a controller-signed native seal that omits a finalized artifact", async () => {
    const fixture = await setupFinalization();
    await expect(
      finalizeProbeSegment(
        finalizationOptions(
          fixture,
          makeControllerAdapters(fixture, {
            captureQuiescedEvidenceSeal: async (binding) => {
              const nativeSeal = await makeNativeSeal(
                fixture.store,
                binding.exactArtifactPaths.slice(1),
                fixture.rootObjectIdentity,
              );
              return {
                nativeSeal,
                controllerReceipt: signedControllerReceipt({
                  prepared: fixture.prepared,
                  nativeSeal,
                  rowId: fixture.rowId,
                  variantId: fixture.variantId,
                  runAuthorization: fixture.runAuthorization,
                  finalizationIntent: binding.finalizationIntent,
                  quiescenceLease: binding.quiescenceLease,
                  privateKey: fixture.privateKey,
                }),
              };
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "FINALIZER_NATIVE_ARTIFACT_SET" });
  });
});
