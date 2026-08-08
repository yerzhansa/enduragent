import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  prepared: null as unknown,
  prepareContext: vi.fn(),
  validatePrepared: vi.fn((value: unknown) => value),
  createPreflightReaders: vi.fn(async () => ({})),
  createFinalizerAdapters: vi.fn(),
  reduceTranscript: vi.fn(async () => ({})),
  validateNativeTranscript: vi.fn((value: unknown) => value),
  finalizeSegment: vi.fn(),
  verifyCommittedSegment: vi.fn(),
  finalizeCampaign: vi.fn(),
  deriveDependencies: vi.fn(() => ["d".repeat(64)]),
}));

vi.mock("../scripts/windows-host-falsifier/probe-preflight.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/windows-host-falsifier/probe-preflight.mjs")
  >()),
  prepareAuthoritativeProbeContext: runtimeMocks.prepareContext,
  validatePreparedProbeContext: runtimeMocks.validatePrepared,
}));

vi.mock("../scripts/windows-host-falsifier/probe-adapters.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/windows-host-falsifier/probe-adapters.mjs")
  >()),
  createProbePreflightReaders: runtimeMocks.createPreflightReaders,
  createProbeFinalizerAdapters: runtimeMocks.createFinalizerAdapters,
}));

vi.mock("../scripts/windows-host-falsifier/probe-transcript.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/windows-host-falsifier/probe-transcript.mjs")
  >()),
  reduceProbeSourceTranscript: runtimeMocks.reduceTranscript,
}));

vi.mock("../scripts/windows-host-falsifier/native-client.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/windows-host-falsifier/native-client.mjs")>()),
  validateNativeCommandTranscript: runtimeMocks.validateNativeTranscript,
}));

vi.mock("../scripts/windows-host-falsifier/probe-finalizer.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../scripts/windows-host-falsifier/probe-finalizer.mjs")
  >()),
  finalizeProbeSegment: runtimeMocks.finalizeSegment,
  verifyCommittedProbeSegment: runtimeMocks.verifyCommittedSegment,
  finalizeProbeCampaign: runtimeMocks.finalizeCampaign,
}));

vi.mock("../scripts/windows-host-falsifier/probe-runner.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/windows-host-falsifier/probe-runner.mjs")>()),
  deriveProbeWorkUpstreamSelectionDigests: runtimeMocks.deriveDependencies,
}));

import {
  PROBE_ENVIRONMENT_IDS,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  deriveCandidateDigest,
  deriveExternalCheckpointReceiptDigest,
  deriveExternalCheckpointRequestDigest,
  deriveLabAttestationDigest,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { createProbeBrokerEnrollment } from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { PROBE_BROKER_ROLES } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import type {
  ProbeCandidateDigestFields,
  ProbeCandidateIdentity,
  ProbeExternalCheckpointRequest,
  ProbeLabAttestation,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { openEvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import type { EvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import { getProbeActionMapping } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import {
  createProbeControllerActionAttestation,
  createProbeControllerActionExecutionReceipt,
  probeControllerActionAttestationPath,
  probeControllerActionProvenancePaths,
} from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import { probeControllerActionCommitMarkerPath } from "../scripts/windows-host-falsifier/probe-controller-spool-transport.mjs";
import {
  createProbeRuntimeActionBinding,
  deriveProbeRuntimeActionPaths,
} from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import {
  createProbeAuthoritativeRuntime,
  deriveProbeRuntimeScenarioOperationId,
  type ProbeAuthoritativeRuntimeConfig,
  type ProbeRuntimeActionInput,
  type ProbeRuntimeHardCutReceiptReadResult,
  type ProbeRuntimeHardCutReceiptReadInput,
  type ProbeRuntimeHardCutRequestInput,
  type ProbeRuntimeControllerTransport,
} from "../scripts/windows-host-falsifier/probe-authoritative-runtime.mjs";
import { probeSegmentArtifactPaths } from "../scripts/windows-host-falsifier/probe-finalizer.mjs";
import {
  PROBE_RUN_PLAN,
  PROBE_RUN_PLAN_SHA256,
  parseAuthoritativeProbeCommand,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import type {
  ProbeRunnerContinuationCommand,
  ProbeRunnerFinalizeCampaignCommand,
  ProbeRunnerFinalizeSegmentCommand,
  ProbeRunnerPrepareCommand,
  ProbeRunWorkItem,
  ProbeRunnerSegmentCommand,
} from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { getProbeScenarioDefinition } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";
import {
  deriveProbeOperatorTrustStoreDigest,
  deriveProbeRunAuthorizationClaimReceiptDigest,
  deriveProbeRunAuthorizationDigest,
  verifyProbeRunAuthorizationAtController,
  type ProbeOperatorTrustStore,
  type ProbeRunAuthorization,
  type ProbeRunAuthorizationClaimReceipt,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";

const sha = (character: string) => character.repeat(64);
const nativeTranscriptSha256 = sha("5");
const nativeCandidateDigest = sha("d");
const nativeManifestSha256 = sha("e");
const rootObjectIdentity = "synthetic-root-object";
const rootObjectIdentitySha256 = createHash("sha256")
  .update(rootObjectIdentity, "utf8")
  .digest("hex");
const { privateKey: controllerPrivateKey, publicKey: controllerPublicKey } =
  generateKeyPairSync("ed25519");
const { privateKey: operatorPrivateKey, publicKey: operatorPublicKey } =
  generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerPublicKey.export({ format: "der", type: "spki" });
const controllerPublicKeySha256 = createHash("sha256")
  .update(controllerPublicKeyBytes)
  .digest("hex");
const operatorPublicKeyBytes = operatorPublicKey.export({ format: "der", type: "spki" });
const operatorPublicKeySha256 = createHash("sha256").update(operatorPublicKeyBytes).digest("hex");

function candidate(): ProbeCandidateIdentity {
  const fields: ProbeCandidateDigestFields = {
    schemaVersion: 1,
    kind: "windows-host-probe-candidate",
    repositoryCommit: "c".repeat(40),
    sourceHashes: [
      {
        path: "apps/desktop/scripts/windows-host-falsifier/native-client.mjs",
        sha256: sha("1"),
      },
      {
        path: "apps/desktop/scripts/windows-host-falsifier/probe-contract.mjs",
        sha256: sha("2"),
      },
      {
        path: "apps/desktop/scripts/windows-host-falsifier/probe-registry.mjs",
        sha256: sha("3"),
      },
      {
        path: "apps/desktop/scripts/windows-host-falsifier/probe-transcript.mjs",
        sha256: sha("4"),
      },
    ],
    binaryHashes: [{ path: "bin/native-helper.exe", sha256: sha("6") }],
    compiler: {
      provider: "Microsoft.CSharp.CSharpCodeProvider",
      codeDomProviderAssemblyVersion: "4.0.0.0",
      cscFileVersion: "4.8.9256.0",
      cscSha256: sha("7"),
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
      powerShellExecutableSha256: sha("8"),
      clrVersion: "v4.0.30319",
      runtimeDirectorySha256Before: sha("9"),
      runtimeDirectorySha256After: sha("9"),
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
    configurationSha256: sha("a"),
  };
  return { ...fields, candidateSha256: deriveCandidateDigest(fields) };
}

function attestation(environmentId: "win11-floor" | "win11-current"): ProbeLabAttestation {
  const fields: Omit<ProbeLabAttestation, "attestationSha256"> = {
    schemaVersion: 1,
    kind: "sanitized-windows-11-lab-attestation",
    environmentId,
    sanitized: true,
    host: {
      windowsEdition: "Windows 11 Pro",
      osCaption: "Microsoft Windows 11 Pro",
      windowsVersion: environmentId === "win11-floor" ? "24H2" : "25H2",
      osBuild: environmentId === "win11-floor" ? "26100" : "26200",
      patchLevel: "synthetic-runtime-fixture",
      productType: "workstation",
      machineArchitecture: "x64",
      processArchitecture: "x64",
      systemVolumeFileSystem: "NTFS",
      systemVolumeIdSha256: sha("1"),
      testVolumeFileSystem: "NTFS",
      testVolumeIdSha256: sha("2"),
      standardUserSidSha256: sha("3"),
      elevated: false,
      defenderRealtimeEnabled: true,
      uacDefault: true,
      developerModeEnabled: false,
    },
    snapshot: {
      vmImageId: `${environmentId}-image`,
      vmImageSha256: sha("4"),
      vmSnapshotId: `${environmentId}-clean-snapshot`,
      cleanImageVersion: "2026.08.07.1",
    },
    runner: {
      version: "2.327.1",
      labels: [
        "enduragent-falsifier",
        "self-hosted",
        environmentId,
        "windows",
        "windows-11",
        "x64",
      ],
      interactiveSessionOwnerSidSha256: sha("3"),
    },
    runtime: {
      nodeVersion: "24.5.0",
      powerShellVersion: "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256: sha("8"),
      clrVersion: "v4.0.30319",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      nsisExecutableSha256: sha("6"),
    },
    controller: {
      identitySha256: sha("b"),
      publicKeySha256: controllerPublicKeySha256,
      publicKeyArtifact: {
        path: "attestations/controller-public-key.spki.der",
        sha256: controllerPublicKeySha256,
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
          path: `attestations/${environmentId}-ascii-guest.json`,
          sha256: sha("c"),
        },
      },
      {
        pathProfileId: "spaces-unicode",
        artifact: {
          path: `attestations/${environmentId}-spaces-unicode-guest.json`,
          sha256: sha("e"),
        },
      },
    ],
    controllerEvidence: {
      path: `attestations/${environmentId}-controller.json`,
      sha256: sha("d"),
    },
  };
  return { ...fields, attestationSha256: deriveLabAttestationDigest(fields) };
}

function commandFlags(command: string, extra: readonly string[]) {
  return [
    "--mode=authoritative",
    "--campaign-run-id=campaign-run-one",
    `--plan-sha256=${PROBE_RUN_PLAN_SHA256}`,
    `--command=${command}`,
    ...extra,
  ];
}

function coordinateFlags(rowId: string, variantId: string) {
  return [
    "--attempt-id=attempt-one",
    "--environment-id=win11-floor",
    "--path-profile-id=ascii",
    `--row-id=${rowId}`,
    `--variant-id=${variantId}`,
  ];
}

function prepareCommand() {
  return parseAuthoritativeProbeCommand(
    commandFlags("prepare", [
      "--execution-run-id=execution-one",
      "--execution-bundle-id=bundle-one",
      "--attempt-id=attempt-one",
      "--environment-id=win11-floor",
      "--path-profile-id=ascii",
    ]),
  ) as ProbeRunnerPrepareCommand;
}

function segmentCommand(rowId: string, variantId: string) {
  return parseAuthoritativeProbeCommand(
    commandFlags("segment", coordinateFlags(rowId, variantId)),
  ) as ProbeRunnerSegmentCommand;
}

function continuationCommand(
  command: "checkpoint" | "resume",
  repetition: number,
  variantId = "f07-hard-cut-after-file-flush",
) {
  return parseAuthoritativeProbeCommand(
    commandFlags(command, [...coordinateFlags("F-07", variantId), `--repetition=${repetition}`]),
  ) as ProbeRunnerContinuationCommand;
}

function finalizeSegmentCommand(rowId: string, variantId: string) {
  return parseAuthoritativeProbeCommand(
    commandFlags("finalize", ["--scope=segment", ...coordinateFlags(rowId, variantId)]),
  ) as ProbeRunnerFinalizeSegmentCommand;
}

function finalizeCampaignCommand() {
  return parseAuthoritativeProbeCommand(
    commandFlags("finalize", ["--scope=campaign"]),
  ) as ProbeRunnerFinalizeCampaignCommand;
}

async function ensureDirectory(store: EvidenceStore, path: string) {
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

function createMemoryEvidenceStore(root: string): EvidenceStore {
  const artifacts = new Map<string, Buffer>();
  const directories = new Set([""]);
  const missing = () => Object.assign(new Error("evidence artifact is absent"), { code: "ENOENT" });
  const existing = () =>
    Object.assign(new Error("evidence artifact already exists"), { code: "EEXIST" });
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  return {
    root,
    createDirectory: async (path) => {
      if (directories.has(path)) throw existing();
      directories.add(path);
      return path;
    },
    writeBytes: async (path, value) => {
      if (artifacts.has(path)) throw existing();
      const bytes = Buffer.from(value);
      artifacts.set(path, bytes);
      return { path, sha256: digest(bytes) };
    },
    writeCanonicalJson: async (path, value) => {
      if (artifacts.has(path)) throw existing();
      const bytes = Buffer.from(canonicalProbeJson(value), "utf8");
      artifacts.set(path, bytes);
      return { path, sha256: digest(bytes) };
    },
    readArtifact: async (path) => {
      const retained = artifacts.get(path);
      if (retained === undefined) throw missing();
      const bytes = Buffer.from(retained);
      return { path, bytes, size: bytes.length, sha256: digest(bytes) };
    },
    verifyArtifactSet: async (declarations) => {
      for (const declaration of declarations) {
        const retained = artifacts.get(declaration.path);
        if (retained === undefined || digest(retained) !== declaration.sha256) throw missing();
      }
      return declarations;
    },
    scan: async () => {
      const retained = [...artifacts.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) }));
      return {
        files: retained.length,
        totalBytes: retained.reduce((total, artifact) => total + artifact.bytes, 0),
        artifacts: retained,
      };
    },
    list: async (path) => {
      if (!directories.has(path)) throw missing();
      const prefix = path.length === 0 ? "" : `${path}/`;
      const entries = new Map<string, "directory" | "file">();
      for (const directory of directories) {
        if (!directory.startsWith(prefix) || directory === path) continue;
        const name = directory.slice(prefix.length).split("/")[0];
        entries.set(name, "directory");
      }
      for (const artifact of artifacts.keys()) {
        if (!artifact.startsWith(prefix)) continue;
        const remainder = artifact.slice(prefix.length);
        const [name, ...descendants] = remainder.split("/");
        entries.set(name, descendants.length === 0 ? "file" : "directory");
      }
      return [...entries]
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([name, kind]) => ({ name, kind }));
    },
    assertRootStable: async () => undefined,
  };
}

function preparedContext(
  identity: ProbeCandidateIdentity,
  floor: ProbeLabAttestation,
  runAuthorization: ProbeRunAuthorization,
  runAuthorizationClaim: ProbeRunAuthorizationClaimReceipt,
) {
  return {
    schemaVersion: 1,
    kind: "windows-host-probe-prepared-context",
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: identity.candidateSha256,
    labAttestationSha256: floor.attestationSha256,
    runPlanSha256: runAuthorization.runPlanSha256,
    runAuthorizationSha256: runAuthorization.authorizationSha256,
    runAuthorizationClaimReceiptSha256: runAuthorizationClaim.receiptSha256,
    campaignRunId: "campaign-run-one",
    executionRunId: "execution-one",
    executionBundleId: "bundle-one",
    executionBundleManifestSha256: sha("e"),
    attemptId: "attempt-one",
    environmentId: "win11-floor" as const,
    pathProfileId: "ascii" as const,
    vmSnapshotId: floor.snapshot.vmSnapshotId,
    bootIdSha256: sha("1"),
    runnerSessionIdSha256: sha("2"),
    lifecyclePolicySha256: sha("3"),
    trustedEvaluationAt: "2026-08-07T00:00:00.000Z",
    controllerPublicKeyArtifact: floor.controller.publicKeyArtifact,
    pathProfileObservation: {
      profileId: "ascii",
      rootPathSha256: sha("4"),
      evidenceRootObjectIdentitySha256: rootObjectIdentitySha256,
      volumeIdSha256: sha("5"),
      localAbsolute: true,
      networkPath: false,
      removableVolume: false,
      reparsePoint: false,
      nfcNormalized: true,
      containsSpaces: false,
      containsUnicode: false,
    },
    executionBundleManifest: {
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
      controller: {
        identitySha256: floor.controller.identitySha256,
        publicKeySha256: floor.controller.publicKeySha256,
        publicKeyArtifact: floor.controller.publicKeyArtifact,
        version: floor.controller.version,
      },
      actors: {
        primaryStandardUserSidSha256: floor.host.standardUserSidSha256,
        powerControlActorSha256: sha("4"),
        snapshotControlActorSha256: sha("5"),
        remotePeerActorSha256: sha("6"),
        secondUserSidSha256: sha("7"),
      },
      binaries: {
        nativeHelper: {
          path: "bin/native-helper.exe",
          sha256: sha("6"),
          machine: "x64",
          nativeCandidateDigest,
          nativeManifestSha256,
        },
        nsis: { path: "bin/nsis.exe", sha256: sha("7") },
      },
      evidenceArtifacts: [],
    },
    preparationScopeSha256: sha("8"),
    preparationClaimReceiptSha256: sha("9"),
    preflightSha256: sha("a"),
  };
}

function operatorTrustStore(): ProbeOperatorTrustStore {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-operator-trust-store" as const,
    trustStoreId: "windows-lab-operators",
    generation: 1,
    keys: [
      {
        operatorKeyId: "operator-one",
        publicKeySpkiBase64: operatorPublicKeyBytes.toString("base64"),
        publicKeySha256: operatorPublicKeySha256,
        status: "active" as const,
      },
    ],
  };
  return { ...unsigned, trustStoreSha256: deriveProbeOperatorTrustStoreDigest(unsigned) };
}

function runAuthorization(
  identity: ProbeCandidateIdentity,
  attestations: readonly ProbeLabAttestation[],
): ProbeRunAuthorization {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: identity.candidateSha256,
    campaignRunId: "campaign-run-one",
    attestations: attestations
      .map(({ environmentId, attestationSha256 }) => ({ environmentId, attestationSha256 }))
      .sort((left, right) => left.environmentId.localeCompare(right.environmentId, "en-US")),
    issuedAt: "2026-08-07T00:00:00.000Z",
    expiresAt: "2026-08-08T00:00:00.000Z",
    operatorKeyId: "operator-one",
    trustStoreId: "windows-lab-operators",
    trustStoreGeneration: 1,
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

function authorizationClaim(
  authorization: ProbeRunAuthorization,
  currentAttestation: ProbeLabAttestation,
  evidenceRootObjectIdentitySha256: string,
): ProbeRunAuthorizationClaimReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization-claim-receipt" as const,
    campaignId: authorization.campaignId,
    manifestSha256: authorization.manifestSha256,
    runPlanSha256: authorization.runPlanSha256,
    candidateSha256: authorization.candidateSha256,
    campaignRunId: authorization.campaignRunId,
    environmentId: currentAttestation.environmentId,
    labAttestationSha256: currentAttestation.attestationSha256,
    evidenceRootObjectIdentitySha256,
    authorizationSha256: authorization.authorizationSha256,
    operatorKeyId: authorization.operatorKeyId,
    operatorPublicKeySha256,
    trustStoreId: authorization.trustStoreId,
    trustStoreGeneration: authorization.trustStoreGeneration,
    trustStoreSha256: operatorTrustStore().trustStoreSha256,
    verifiedAt: "2026-08-07T00:00:20.000Z",
    authorizationExpiresAt: authorization.expiresAt,
    controllerIdentitySha256: currentAttestation.controller.identitySha256,
    controllerPublicKeySha256: currentAttestation.controller.publicKeySha256,
    controllerVersion: currentAttestation.controller.version,
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

interface SignedControllerState {
  readonly authorizationClaims: Map<string, ProbeRunAuthorizationClaimReceipt>;
  readonly hardCutsByScope: Map<string, ProbeExternalCheckpointRequest>;
  readonly nonceOwners: Map<string, string>;
  readonly requestOwners: Map<string, string>;
  forceNonceSha256: string | null;
  forgeNextRequestSignature: boolean;
  equalBootReceiptOnce: boolean;
  verificationInstant: string;
}

function signedControllerState(): SignedControllerState {
  return {
    authorizationClaims: new Map(),
    hardCutsByScope: new Map(),
    nonceOwners: new Map(),
    requestOwners: new Map(),
    forceNonceSha256: null,
    forgeNextRequestSignature: false,
    equalBootReceiptOnce: false,
    verificationInstant: "2026-08-07T00:00:20.000Z",
  };
}

interface Harness {
  readonly store: EvidenceStore;
  readonly runtime: ReturnType<typeof createProbeAuthoritativeRuntime>;
  readonly actionOperations: string[];
  readonly actionInputs: ProbeRuntimeActionInput[];
  readonly claimRequest: ReturnType<typeof vi.fn>;
  readonly verifyAuthorization: ReturnType<typeof vi.fn>;
  readonly readReceipt: ReturnType<typeof vi.fn>;
  readonly verifyHardCutReceipt: ReturnType<typeof vi.fn>;
  readonly signer: ReturnType<typeof vi.fn>;
  readonly invokeControllerAction: ReturnType<typeof vi.fn>;
  readonly verifyActionReceipt: ReturnType<typeof vi.fn>;
  readonly observeBrokerMailbox: ReturnType<typeof vi.fn>;
  readonly readNativeTranscript: ReturnType<typeof vi.fn>;
  readonly retainControllerObserverTranscript: (
    workItem: ProbeRunWorkItem,
    transcriptSha256: string,
    nativeSessionId?: string,
  ) => Promise<void>;
  readonly runAuthorization: ProbeRunAuthorization;
  readonly controllerState: SignedControllerState;
  readonly postBootIds: string[];
}

const roots: string[] = [];

async function createHarness({
  controllerState = signedControllerState(),
  failActionCaptureWriteOnce = false,
  failActionCaptureForActionOnce = null,
  failHardCutRequestWriteOnce = false,
  failHardCutStagingWriteOnce = false,
  failHardCutResumeWriteOnce = false,
  failReceiptTransactionWriteOnce = false,
  failSourceReceiptWriteOnce = false,
  nativeTermination = { mode: "clean-eof", code: 0, signal: null },
  transcriptNativeCandidateDigest = nativeCandidateDigest,
  transcriptNativeManifestSha256 = nativeManifestSha256,
  retainedNativeTranscriptSha256 = nativeTranscriptSha256,
  primaryObserverTranscriptSha256sByAction = {},
  memoryEvidenceStore = false,
  configureRuntime,
}: {
  controllerState?: SignedControllerState;
  failActionCaptureWriteOnce?: boolean;
  failActionCaptureForActionOnce?: string | null;
  failHardCutRequestWriteOnce?: boolean;
  failHardCutStagingWriteOnce?: boolean;
  failHardCutResumeWriteOnce?: boolean;
  failReceiptTransactionWriteOnce?: boolean;
  failSourceReceiptWriteOnce?: boolean;
  nativeTermination?: Readonly<Record<string, unknown>> | null;
  transcriptNativeCandidateDigest?: string;
  transcriptNativeManifestSha256?: string;
  retainedNativeTranscriptSha256?: string;
  primaryObserverTranscriptSha256sByAction?: Readonly<Record<string, readonly string[]>>;
  memoryEvidenceStore?: boolean;
  configureRuntime?: (config: ProbeAuthoritativeRuntimeConfig) => void;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "probe-authoritative-runtime-"));
  roots.push(root);
  const evidenceStore = memoryEvidenceStore
    ? createMemoryEvidenceStore(root)
    : await openEvidenceStore({ root });
  let rejectActionCapture = failActionCaptureWriteOnce;
  let rejectActionCaptureForAction = failActionCaptureForActionOnce;
  let rejectHardCutRequest = failHardCutRequestWriteOnce;
  let rejectHardCutStaging = failHardCutStagingWriteOnce;
  let rejectHardCutResume = failHardCutResumeWriteOnce;
  let rejectReceiptTransaction = failReceiptTransactionWriteOnce;
  let rejectSourceReceipt = failSourceReceiptWriteOnce;
  const store: EvidenceStore = {
    root: evidenceStore.root,
    createDirectory: (path) => evidenceStore.createDirectory(path),
    writeBytes: (path, value) => {
      if (rejectHardCutStaging && path.includes("/hard-cuts/staged/")) {
        rejectHardCutStaging = false;
        return Promise.reject(
          Object.assign(new Error("injected hard-cut staging write failure"), { code: "EIO" }),
        );
      }
      if (
        (rejectActionCapture && path.includes("/actions/")) ||
        (rejectActionCaptureForAction !== null &&
          path.endsWith(`/actions/${rejectActionCaptureForAction}.json`))
      ) {
        rejectActionCapture = false;
        rejectActionCaptureForAction = null;
        return Promise.reject(
          Object.assign(new Error("injected action capture write failure"), { code: "EIO" }),
        );
      }
      if (rejectHardCutResume && path.endsWith("-resume.json")) {
        rejectHardCutResume = false;
        return Promise.reject(
          Object.assign(new Error("injected hard-cut resume write failure"), { code: "EIO" }),
        );
      }
      if (rejectHardCutRequest && path.endsWith("-request.json")) {
        rejectHardCutRequest = false;
        return Promise.reject(
          Object.assign(new Error("injected hard-cut request write failure"), { code: "EIO" }),
        );
      }
      if (rejectSourceReceipt && path.endsWith("/evidence/source-transcript-receipt.json")) {
        rejectSourceReceipt = false;
        return Promise.reject(
          Object.assign(new Error("injected receipt write failure"), { code: "EIO" }),
        );
      }
      return evidenceStore.writeBytes(path, value);
    },
    writeCanonicalJson: (path, value) => {
      if (rejectReceiptTransaction && path.startsWith("continuations/receipt-transactions/")) {
        rejectReceiptTransaction = false;
        return Promise.reject(
          Object.assign(new Error("injected receipt transaction write failure"), { code: "EIO" }),
        );
      }
      return evidenceStore.writeCanonicalJson(path, value);
    },
    readArtifact: (path) => evidenceStore.readArtifact(path),
    verifyArtifactSet: (declarations) => evidenceStore.verifyArtifactSet(declarations),
    scan: () => evidenceStore.scan(),
    list: (path) => evidenceStore.list(path),
    assertRootStable: () => evidenceStore.assertRootStable(),
  };
  await ensureDirectory(store, "attestations");
  await store.writeBytes("attestations/controller-public-key.spki.der", controllerPublicKeyBytes);
  const identity = candidate();
  const attestations = [attestation("win11-floor"), attestation("win11-current")];
  const authorization = runAuthorization(identity, attestations);
  const initialClaim = authorizationClaim(authorization, attestations[0], rootObjectIdentitySha256);
  const prepared = preparedContext(identity, attestations[0], authorization, initialClaim);
  runtimeMocks.prepared = prepared;
  runtimeMocks.prepareContext.mockImplementation(async () => prepared);
  runtimeMocks.createPreflightReaders.mockResolvedValue({
    readPreparationTransaction: vi.fn(async () => null),
    observeGuest: vi.fn(async () => ({
      pathProfile: { evidenceRootObjectIdentitySha256: rootObjectIdentitySha256 },
    })),
  });
  const finalizerAdapters = {
    readRepositoryState: vi.fn(async () => ({})),
    readVerifierSource: vi.fn(async () => new Uint8Array([1])),
    readContractSource: vi.fn(async () => new Uint8Array([2])),
    readTranscriptSource: vi.fn(async () => new Uint8Array([3])),
    readNativeClientSource: vi.fn(async () => new Uint8Array([4])),
    readNativeManifestDigestSource: vi.fn(async () => new Uint8Array([5])),
    recoverOrAcquireEvidenceQuiescence: vi.fn(async () => ({})),
    renewEvidenceQuiescence: vi.fn(async () => ({})),
    captureQuiescedEvidenceSeal: vi.fn(async () => ({})),
    completeEvidenceQuiescence: vi.fn(async () => ({})),
    abandonEvidenceQuiescence: vi.fn(async () => ({})),
    now: () => new Date("2026-08-07T00:00:10.000Z"),
    monotonicNow: () => 10,
  };
  runtimeMocks.createFinalizerAdapters.mockResolvedValue(finalizerAdapters);
  const actionOperations: string[] = [];
  const actionInputs: ProbeRuntimeActionInput[] = [];
  const retainScenarioActionResult = async (input: ProbeRuntimeActionInput) => {
    const action = input.invocation.action;
    actionInputs.push(input);
    actionOperations.push(action.operation);
    const paths = probeSegmentArtifactPaths(input.workItem);
    await ensureDirectory(store, paths.evidence);
    const evidencePath = `${paths.evidence}/${action.actionId}.json`;
    let artifact;
    try {
      artifact = await store.writeCanonicalJson(evidencePath, { actionId: action.actionId });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      artifact = await store.readArtifact(evidencePath);
    }
    const definition = getProbeScenarioDefinition(input.command.rowId, input.command.variantId);
    const result = {
      actionId: action.actionId,
      commandEvent:
        action.capture === null
          ? null
          : {
              sequence: action.capture.sequence,
              producerKind: definition.transcriptProducerKind,
              commandId: action.capture.commandId,
              requestSha256: sha("1"),
              responseSha256: sha("2"),
              nativeTranscriptSha256s: [retainedNativeTranscriptSha256],
              observations: action.capture.factKeys.map((factKey) => ({
                factKey,
                valueKind: "null" as const,
                value: null,
              })),
            },
      evidenceArtifacts: [{ path: artifact.path, sha256: artifact.sha256 }],
    };
    await ensureDirectory(store, input.operationResultPath.split("/").slice(0, -1).join("/"));
    let resultArtifact;
    try {
      resultArtifact = await store.writeCanonicalJson(input.operationResultPath, result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      resultArtifact = await store.readArtifact(input.operationResultPath);
    }
    return resultArtifact;
  };
  const nativeTranscriptBytes = (
    transcriptSha256: string,
    nativeSessionId = "native-session-one",
  ) => {
    const transcript = {
      schemaVersion: 1,
      kind: "windows-host-native-command-transcript",
      binding: {
        campaignRunId: prepared.campaignRunId,
        candidateSha256: prepared.candidateSha256,
        preflightSha256: prepared.preflightSha256,
        executionBundleManifestSha256: prepared.executionBundleManifestSha256,
        nativeHelperArtifactPath: prepared.executionBundleManifest.binaries.nativeHelper.path,
        nativeHelperSha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
        evidenceRootObjectIdentitySha256: rootObjectIdentitySha256,
        nativeCandidateDigest: transcriptNativeCandidateDigest,
        nativeManifestSha256: transcriptNativeManifestSha256,
        nativeSessionId,
        runRootIdentity: rootObjectIdentity,
        startupHandshakeSha256: sha("f"),
      },
      records: [
        {
          kind: "command",
          sequence: 1,
          requestId: "request-one",
          command: "home-identity",
          operationId: "operation-one",
          requestFrameSha256: sha("1"),
          responseFrameSha256: sha("2"),
          ok: true,
          request: {},
          result: {},
        },
      ],
      termination: nativeTermination,
      transcriptSha256,
    };
    return Buffer.from(canonicalProbeJson(transcript), "utf8");
  };
  const readNativeTranscript = vi.fn(async () => {
    return nativeTranscriptBytes(retainedNativeTranscriptSha256);
  });
  const retainControllerObserverTranscript = async (
    item: ProbeRunWorkItem,
    transcriptSha256: string,
    nativeSessionId = "controller-observer-session",
  ) => {
    const path = `${probeSegmentArtifactPaths(item).nativeTranscripts}/${transcriptSha256}.json`;
    await ensureDirectory(store, path.split("/").slice(0, -1).join("/"));
    try {
      await store.writeBytes(path, nativeTranscriptBytes(transcriptSha256, nativeSessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };
  const invokeNativeAction = async (input: ProbeRuntimeActionInput) => {
    const resultArtifact = await retainScenarioActionResult(input);
    return { operationId: input.operationId, resultSha256: resultArtifact.sha256 };
  };
  const controllerActionReceipts = new Map<
    string,
    {
      readonly operationId: string;
      readonly resultSha256: string;
      readonly receiptSha256: string;
      readonly provenanceSha256: string;
      readonly actionAttestationSha256: string | null;
      readonly primaryObserverTranscriptSha256s: readonly string[];
    }
  >();
  const invokeControllerAction = vi.fn(async (input: ProbeRuntimeActionInput) => {
    const resultArtifact = await retainScenarioActionResult(input);
    let actionAttestationSha256: string | null = null;
    if (input.invocation.action.capture !== null) {
      const retainedResult = await store.readArtifact(resultArtifact.path);
      const actionResult = JSON.parse(retainedResult.bytes.toString("utf8")) as {
        commandEvent: {
          commandId: string;
          requestSha256: string;
          responseSha256: string;
          nativeTranscriptSha256s: readonly string[];
        };
      };
      const binding = createProbeRuntimeActionBinding({
        command: input.command,
        invocation: input.invocation,
        preparedContext: input.preparedContext,
      });
      const coordinate = {
        campaignRunId: input.command.campaignRunId,
        executionRunId: input.preparedContext.executionRunId,
        attemptId: input.command.attemptId,
        workId: input.command.workId,
        environmentId: input.command.environmentId,
        pathProfileId: input.command.pathProfileId,
        rowId: input.command.rowId,
        variantId: input.command.variantId,
        repetition: input.command.repetition ?? null,
      };
      const attestation = createProbeControllerActionAttestation({
        candidateSha256: input.preparedContext.candidateSha256,
        executionBundleId: input.preparedContext.executionBundleId,
        executionBundleManifestSha256: input.preparedContext.executionBundleManifestSha256,
        runAuthorizationClaimReceiptSha256:
          input.preparedContext.runAuthorizationClaimReceiptSha256,
        coordinate,
        scenarioPlanSha256: input.invocation.planSha256,
        producerActionId: input.invocation.action.actionId,
        operation: {
          operationId: input.operationId,
          kind: "scenario-action",
          sequence: input.invocation.action.sequence,
        },
        runtimeActionIntentSha256: binding.operationIntentSha256,
        execution: input.execution,
        expectedActor: binding.expectedActor,
        broker: null,
        observerCommands: actionResult.commandEvent.nativeTranscriptSha256s.map(
          (transcriptSha256) => ({
            transcriptSha256,
            sequence: 1,
            commandId: actionResult.commandEvent.commandId,
            requestFrameSha256: actionResult.commandEvent.requestSha256,
            responseFrameSha256: actionResult.commandEvent.responseSha256,
            ok: true,
          }),
        ),
      });
      const path = probeControllerActionAttestationPath({
        coordinate,
        producerActionId: input.invocation.action.actionId,
      });
      await ensureDirectory(store, path.split("/").slice(0, -1).join("/"));
      await store.writeCanonicalJson(path, attestation);
      actionAttestationSha256 = attestation.attestationSha256;
    }
    const acknowledgment = {
      operationId: input.operationId,
      resultSha256: resultArtifact.sha256,
      receiptSha256: createHash("sha256")
        .update(`receipt:${input.operationId}`, "utf8")
        .digest("hex"),
      provenanceSha256: createHash("sha256")
        .update(`provenance:${input.operationId}`, "utf8")
        .digest("hex"),
      actionAttestationSha256,
      primaryObserverTranscriptSha256s: [
        ...(primaryObserverTranscriptSha256sByAction[input.invocation.action.actionId] ?? []),
      ].sort(),
    };
    controllerActionReceipts.set(input.operationId, acknowledgment);
    return acknowledgment;
  });
  const verifyActionReceipt = vi.fn(async (input: ProbeRuntimeActionInput) => {
    const acknowledgment = controllerActionReceipts.get(input.operationId);
    if (acknowledgment === undefined) {
      throw Object.assign(new Error("controller action provenance is absent"), {
        code: "CONTROLLER_ACTION_PROVENANCE_MISSING",
      });
    }
    const resultArtifact = await store.readArtifact(input.operationResultPath);
    if (resultArtifact.sha256 !== acknowledgment.resultSha256) {
      throw Object.assign(new Error("controller action result differs from provenance"), {
        code: "CONTROLLER_ACTION_PROVENANCE_INVALID",
      });
    }
    return acknowledgment;
  });
  const signer = vi.fn(async () => ({ signatureBase64: "AQ==" }));
  const verifyAuthorization = vi.fn(
    async (input: Parameters<ProbeRuntimeControllerTransport["verifyRunAuthorization"]>[0]) => {
      const key = [
        input.runAuthorization.authorizationSha256,
        input.currentAttestation.attestationSha256,
        input.evidenceRootObjectIdentitySha256,
      ].join(":");
      const retained = controllerState.authorizationClaims.get(key);
      if (retained !== undefined) return retained;
      verifyProbeRunAuthorizationAtController(input.runAuthorization, {
        trustStore: operatorTrustStore(),
        candidateSha256: input.candidateSha256,
        campaignRunId: input.campaignRunId,
        attestations: input.attestations
          .map(({ environmentId, attestationSha256 }) => ({
            environmentId,
            attestationSha256,
          }))
          .sort((left, right) => left.environmentId.localeCompare(right.environmentId, "en-US")),
        verificationInstant: new Date(controllerState.verificationInstant),
      });
      const claim = authorizationClaim(
        input.runAuthorization,
        input.currentAttestation,
        input.evidenceRootObjectIdentitySha256,
      );
      controllerState.authorizationClaims.set(key, claim);
      return claim;
    },
  );
  const claimRequest = vi.fn(async (input: ProbeRuntimeHardCutRequestInput) => {
    const command = input.command;
    const scopeKey = `${prepared.campaignRunId}:${input.continuation.scopeSha256}`;
    const retained = controllerState.hardCutsByScope.get(scopeKey);
    if (retained !== undefined) return retained;
    const nonceSha256 =
      controllerState.forceNonceSha256 ??
      createHash("sha256").update(`nonce:${scopeKey}`, "utf8").digest("hex");
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-hard-cut-request" as const,
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
      rowId: command.rowId,
      variantId: command.variantId,
      checkpointId: command.checkpointId,
      sequence: command.repetition,
      nonceSha256,
      preCutStateSha256: input.preCutStateSha256,
      preCutBootIdSha256: input.preCutBootIdSha256,
      sourceVmSnapshotId: prepared.vmSnapshotId,
      continuationScopeSha256: input.continuation.scopeSha256,
      controllerIdentitySha256: attestations[0].controller.identitySha256,
      controllerPublicKeySha256: attestations[0].controller.publicKeySha256,
      controllerVersion: attestations[0].controller.version,
      action: "hard-power-cut" as const,
      signatureAlgorithm: "Ed25519" as const,
    };
    const requestSha256 = deriveExternalCheckpointRequestDigest(unsigned);
    let signatureBase64 = sign(
      null,
      Buffer.from(requestSha256, "hex"),
      controllerPrivateKey,
    ).toString("base64");
    if (controllerState.forgeNextRequestSignature) {
      controllerState.forgeNextRequestSignature = false;
      signatureBase64 = "AQ==";
    }
    const request: ProbeExternalCheckpointRequest = {
      ...unsigned,
      signatureBase64,
      requestSha256,
    };
    const nonceOwner = controllerState.nonceOwners.get(nonceSha256);
    if (nonceOwner !== undefined && nonceOwner !== scopeKey) {
      throw Object.assign(new Error("controller nonce is already claimed"), {
        code: "CONTROLLER_HARD_CUT_REPLAY",
      });
    }
    const requestOwner = controllerState.requestOwners.get(requestSha256);
    if (requestOwner !== undefined && requestOwner !== scopeKey) {
      throw Object.assign(new Error("controller request is already claimed"), {
        code: "CONTROLLER_HARD_CUT_REPLAY",
      });
    }
    controllerState.nonceOwners.set(nonceSha256, scopeKey);
    controllerState.requestOwners.set(requestSha256, scopeKey);
    controllerState.hardCutsByScope.set(scopeKey, request);
    return request;
  });
  const postBootIds: string[] = [];
  const hardCutReceipts = new Map<string, ProbeRuntimeHardCutReceiptReadResult>();
  const hardCutAuthorityArtifacts = new Map<
    string,
    readonly { readonly path: string; readonly sha256: string }[]
  >();
  const readReceipt = vi.fn(async (input: ProbeRuntimeHardCutReceiptReadInput) => {
    const repetition = input.command.repetition;
    const paths = probeSegmentArtifactPaths(input.workItem);
    await ensureDirectory(store, paths.evidence);
    const artifactPath = `${paths.evidence}/hard-cut-receipt-r${repetition}.json`;
    let artifact;
    try {
      artifact = await store.writeCanonicalJson(artifactPath, {
        repetition,
        observedBy: "external-controller",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      artifact = await store.readArtifact(artifactPath);
    }
    const postBootBootIdSha256 = controllerState.equalBootReceiptOnce
      ? input.request.preCutBootIdSha256
      : createHash("sha256")
          .update(`boot:${input.request.preCutBootIdSha256}:${repetition}`, "utf8")
          .digest("hex");
    controllerState.equalBootReceiptOnce = false;
    postBootIds.push(postBootBootIdSha256);
    const fields = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-hard-cut-receipt" as const,
      requestSha256: input.request.requestSha256,
      controllerIdentitySha256: input.request.controllerIdentitySha256,
      controllerPublicKeySha256: input.request.controllerPublicKeySha256,
      controllerVersion: input.request.controllerVersion,
      action: "hard-power-cut" as const,
      powerCutAt: `2026-08-07T00:00:0${repetition}.000Z`,
      bootStartedAt: `2026-08-07T00:00:1${repetition}.000Z`,
      bootCompletedAt: `2026-08-07T00:00:2${repetition}.000Z`,
      postBootVmSnapshotId: `post-boot-snapshot-${repetition}`,
      preCutBootIdSha256: input.request.preCutBootIdSha256,
      postBootBootIdSha256,
      artifactHashes: [{ path: artifact.path, sha256: artifact.sha256 }],
      signatureAlgorithm: "Ed25519" as const,
      receiptSha256: "",
    };
    const receiptSha256 = deriveExternalCheckpointReceiptDigest(fields);
    const signatureBase64 = sign(
      null,
      Buffer.from(receiptSha256, "hex"),
      controllerPrivateKey,
    ).toString("base64");
    const definition = getProbeScenarioDefinition(input.command.rowId, input.command.variantId);
    const action = definition.actions.find(
      ({ actionId }) => actionId === `hard-cut-guest-r${repetition}`,
    );
    if (action === undefined) throw new Error("hard-cut action fixture is missing");
    const invocation = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-scenario-action-invocation" as const,
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action,
    };
    const binding = createProbeRuntimeActionBinding({
      command: input.command,
      invocation,
      preparedContext: input.preparedContext,
    });
    const actionResult = {
      actionId: action.actionId,
      commandEvent: null,
      evidenceArtifacts: [{ path: artifact.path, sha256: artifact.sha256 }],
    };
    await ensureDirectory(store, binding.operationResultPath.split("/").slice(0, -1).join("/"));
    let actionResultArtifact;
    try {
      actionResultArtifact = await store.writeCanonicalJson(
        binding.operationResultPath,
        actionResult,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      actionResultArtifact = await store.readArtifact(binding.operationResultPath);
    }
    const observerTranscriptSha256 = createHash("sha256")
      .update(`hard-cut-observer:${repetition}`, "utf8")
      .digest("hex");
    const observerPath = `${paths.nativeTranscripts}/${observerTranscriptSha256}.json`;
    await ensureDirectory(store, paths.nativeTranscripts);
    const observerBytes = nativeTranscriptBytes(
      observerTranscriptSha256,
      `hard-cut-observer-session-${repetition}`,
    );
    let observerArtifact;
    try {
      observerArtifact = await store.writeBytes(observerPath, observerBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      observerArtifact = await store.readArtifact(observerPath);
    }
    const actionExecutionReceipt = createProbeControllerActionExecutionReceipt({
      candidateSha256: input.preparedContext.candidateSha256,
      executionBundleId: input.preparedContext.executionBundleId,
      executionBundleManifestSha256: input.preparedContext.executionBundleManifestSha256,
      runAuthorizationClaimReceiptSha256: input.preparedContext.runAuthorizationClaimReceiptSha256,
      coordinate: {
        campaignRunId: input.command.campaignRunId,
        executionRunId: input.preparedContext.executionRunId,
        attemptId: input.command.attemptId,
        workId: input.command.workId,
        environmentId: input.command.environmentId,
        pathProfileId: input.command.pathProfileId,
        rowId: input.command.rowId,
        variantId: input.command.variantId,
        repetition,
      },
      scenarioPlanSha256: definition.planSha256,
      producerActionId: action.actionId,
      operation: {
        operationId: binding.operationId,
        kind: "scenario-action",
        sequence: action.sequence,
      },
      intentSha256: binding.operationIntentSha256,
      execution: binding.execution,
      expectedActor: binding.expectedActor,
      actionResult,
      actionResultArtifact: {
        path: actionResultArtifact.path,
        sha256: actionResultArtifact.sha256,
      },
      proofArtifacts: [{ path: artifact.path, sha256: artifact.sha256 }],
      observerTranscripts: [
        {
          path: observerArtifact.path,
          sha256: observerArtifact.sha256,
          transcriptSha256: observerTranscriptSha256,
        },
      ],
      brokerProof: null,
      pausedSessionReceipt: null,
      nativeActionPlans: [],
    });
    const result = {
      checkpointEvidence: {
        request: input.request,
        receipt: { ...fields, signatureBase64, receiptSha256 },
      },
      actionExecutionReceipt,
      actionAcknowledgment: {
        operationId: binding.operationId,
        resultSha256: actionResultArtifact.sha256,
        receiptSha256: actionExecutionReceipt.receiptSha256,
        provenanceSha256: createHash("sha256")
          .update(`hard-cut-provenance:${binding.operationId}`, "utf8")
          .digest("hex"),
        actionAttestationSha256: null,
        primaryObserverTranscriptSha256s: [observerTranscriptSha256],
      },
    };
    const authorityPaths = probeControllerActionProvenancePaths({
      campaignRunId: input.command.campaignRunId,
      attemptId: input.command.attemptId,
      workId: input.command.workId,
      producerActionId: action.actionId,
    });
    const authorityArtifacts: { path: string; sha256: string }[] = [];
    for (const [recordKind, path] of Object.entries({
      receipt: authorityPaths.receipt,
      provenance: authorityPaths.provenance,
      controllerRequest: authorityPaths.controllerRequest,
      operationRequest: authorityPaths.operationRequest,
      controllerResponse: authorityPaths.controllerResponse,
      operationResponse: authorityPaths.operationResponse,
    })) {
      await ensureDirectory(store, path.split("/").slice(0, -1).join("/"));
      let authorityArtifact;
      try {
        authorityArtifact = await store.writeCanonicalJson(path, {
          recordKind,
          operationId: binding.operationId,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        authorityArtifact = await store.readArtifact(path);
      }
      authorityArtifacts.push({ path, sha256: authorityArtifact.sha256 });
    }
    const commitPath = probeControllerActionCommitMarkerPath({
      campaignRunId: input.command.campaignRunId,
      attemptId: input.command.attemptId,
      workId: input.command.workId,
      producerActionId: action.actionId,
    });
    await ensureDirectory(store, commitPath.split("/").slice(0, -1).join("/"));
    const commitArtifact = await store.writeCanonicalJson(commitPath, {
      commitSha256: hashProbeCanonicalJson({
        authorityArtifacts,
        operationId: binding.operationId,
      }),
    });
    authorityArtifacts.push({ path: commitPath, sha256: commitArtifact.sha256 });
    hardCutReceipts.set(input.request.requestSha256, result);
    hardCutAuthorityArtifacts.set(input.request.requestSha256, authorityArtifacts);
    return result;
  });
  const verifyHardCutReceipt = vi.fn(async (input: ProbeRuntimeHardCutReceiptReadInput) => {
    const result = hardCutReceipts.get(input.request.requestSha256);
    if (result === undefined) {
      throw Object.assign(new Error("hard-cut action provenance is absent"), {
        code: "CONTROLLER_HARD_CUT_PROVENANCE_MISSING",
      });
    }
    const authorityArtifacts = hardCutAuthorityArtifacts.get(input.request.requestSha256) ?? [];
    for (const expected of authorityArtifacts) {
      let artifact;
      try {
        artifact = await store.readArtifact(expected.path);
      } catch {
        throw Object.assign(new Error("hard-cut action provenance is absent"), {
          code: "CONTROLLER_HARD_CUT_PROVENANCE_MISSING",
        });
      }
      if (artifact.sha256 !== expected.sha256) {
        throw Object.assign(new Error("hard-cut raw record differs from provenance"), {
          code: "CONTROLLER_HARD_CUT_PROVENANCE_INVALID",
        });
      }
    }
    const artifact = await store.readArtifact(
      result.actionExecutionReceipt.actionResultArtifact.path,
    );
    if (artifact.sha256 !== result.actionAcknowledgment.resultSha256) {
      throw Object.assign(new Error("hard-cut action result differs from provenance"), {
        code: "CONTROLLER_HARD_CUT_PROVENANCE_INVALID",
      });
    }
    return result;
  });
  let monotonic = 0;
  const observeBrokerMailbox = vi.fn(async () => ({}) as never);
  const config: ProbeAuthoritativeRuntimeConfig = {
    campaignRunId: "campaign-run-one",
    candidate: identity,
    attestations,
    runAuthorization: authorization,
    brokerEnrollments: PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
      PROBE_BROKER_ROLES.map((brokerRole) =>
        createProbeBrokerEnrollment({
          environmentId,
          brokerRole,
          brokerInstanceId: `${environmentId}-${brokerRole}-broker`,
          mailboxRoot: `E:\\Broker\\${environmentId}\\${brokerRole}`,
          mailboxAclSha256: createHash("sha256")
            .update(`${environmentId}:${brokerRole}:mailbox-acl`)
            .digest("hex"),
          journalRoot: `E:\\BrokerJournal\\${environmentId}\\${brokerRole}`,
          journalRootAclSha256: createHash("sha256")
            .update(`${environmentId}:${brokerRole}:journal-root-acl`)
            .digest("hex"),
          journalDatabaseAclSha256: createHash("sha256")
            .update(`${environmentId}:${brokerRole}:journal-database-acl`)
            .digest("hex"),
          processSidSha256: createHash("sha256")
            .update(`${environmentId}:${brokerRole}:process-sid`)
            .digest("hex"),
          peerAuthoritySha256:
            brokerRole === "remote-peer"
              ? createHash("sha256")
                  .update(`${environmentId}:${brokerRole}:peer-authority`)
                  .digest("hex")
              : null,
        }),
      ),
    ),
    repositoryRoot: "/synthetic/repository",
    lifecyclePolicy: {
      policyId: "windows-support-policy",
      evaluatedAt: "2026-08-07T00:00:00.000Z",
      mappings: [],
    },
    resolveStore: () => store,
    resolvePreflightRequest: ({ command }) => ({
      campaignRunId: command.campaignRunId,
      executionRunId: command.executionRunId,
      executionBundleId: command.executionBundleId,
      attemptId: command.attemptId,
      environmentId: command.environmentId,
      pathProfileId: command.pathProfileId,
      vmSnapshotId: prepared.vmSnapshotId,
      bootIdSha256: prepared.bootIdSha256,
      runnerSessionIdSha256: prepared.runnerSessionIdSha256,
      nativeHelperArtifactPath: "bin/native-helper.exe",
      nativeCandidateDigest,
      nativeManifestSha256,
      nsisArtifactPath: "bin/nsis.exe",
    }),
    nativeTransport: {
      observeGuest: vi.fn(async () => ({}) as never),
      invokeScenarioAction: invokeNativeAction,
      readNativeTranscript,
    },
    brokerTransport: { observeBrokerMailbox },
    controllerTransport: {
      observeController: vi.fn(async () => ({}) as never),
      verifyRunAuthorization: verifyAuthorization,
      recoverOrAcquireEvidenceQuiescence: vi.fn(async () => ({}) as never),
      renewEvidenceQuiescence: vi.fn(async () => ({}) as never),
      captureQuiescedEvidenceSeal: vi.fn(async () => ({}) as never),
      completeEvidenceQuiescence: vi.fn(async () => ({}) as never),
      abandonEvidenceQuiescence: vi.fn(async () => ({}) as never),
      invokeScenarioAction: invokeControllerAction,
      verifyScenarioActionReceipt: verifyActionReceipt,
      observeCaptureDisposition: vi.fn(async () => ({
        captureComplete: true,
        availability: { status: "available" as const, reason: null },
      })),
      signSourceTranscriptReceipt: signer,
      claimHardCutRequest: claimRequest,
      readHardCutReceipt: readReceipt,
      verifyHardCutReceipt,
    },
    now: () => new Date(controllerState.verificationInstant),
    monotonicNow: () => {
      monotonic += 1;
      return monotonic;
    },
  };
  configureRuntime?.(config);
  return {
    store,
    runtime: createProbeAuthoritativeRuntime(config),
    actionOperations,
    actionInputs,
    claimRequest,
    verifyAuthorization,
    readReceipt,
    verifyHardCutReceipt,
    signer,
    invokeControllerAction,
    verifyActionReceipt,
    observeBrokerMailbox,
    readNativeTranscript,
    retainControllerObserverTranscript,
    runAuthorization: authorization,
    controllerState,
    postBootIds,
  };
}

function workItem(command: ProbeRunnerSegmentCommand | ProbeRunnerContinuationCommand) {
  const item = PROBE_RUN_PLAN.work.find(({ workId }) => workId === command.workId);
  if (item === undefined) throw new Error("test command has no work item");
  return item;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMocks.validatePrepared.mockImplementation((value: unknown) => value);
  runtimeMocks.validateNativeTranscript.mockImplementation((value: unknown) => value);
  runtimeMocks.reduceTranscript.mockResolvedValue({});
  runtimeMocks.deriveDependencies.mockReturnValue([sha("d")]);
  const segment = { segmentSha256: sha("e"), outcome: "PASS" };
  const commit = { commitSha256: sha("f") };
  runtimeMocks.finalizeSegment.mockImplementation(async ({ rowId, variantId, preparedContext }) => {
    const paths = probeSegmentArtifactPaths({
      environmentId: preparedContext.environmentId,
      pathProfileId: preparedContext.pathProfileId,
      rowId,
      variantId,
    });
    return { segment, path: paths.segment, commit, commitPath: paths.segmentCommit };
  });
  runtimeMocks.verifyCommittedSegment.mockImplementation(async ({ commitPath }) => ({
    segment,
    path: commitPath.replace("segment-commit", "segment"),
    commit,
    commitPath,
  }));
  runtimeMocks.finalizeCampaign.mockResolvedValue({
    schemaVersion: 1,
    kind: "windows-host-probe-campaign-result",
    authority: "verified-artifact-finalizer",
    campaignId: "f01-f10-native-probe-v1",
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: sha("f"),
    phase: "probe",
    status: "INCONCLUSIVE",
    selectionEligible: false,
    rowClosureClaimed: false,
    issues: [],
    rowResults: [],
    analysisSha256: sha("1"),
    verifiedSegmentDigests: [],
    campaignResultSha256: sha("2"),
  });
});

describe("authoritative probe runtime composition", () => {
  it("rejects accessor and symbolic runtime transport surfaces before copying them", async () => {
    let getterReads = 0;
    await expect(
      createHarness({
        configureRuntime: (config) => {
          Object.defineProperty(config.nativeTransport, "invokeScenarioAction", {
            enumerable: true,
            configurable: true,
            get: () => {
              getterReads += 1;
              return getterReads === 1 ? vi.fn() : null;
            },
          });
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SCHEMA" });
    expect(getterReads).toBe(0);

    await expect(
      createHarness({
        configureRuntime: (config) => {
          (config.controllerTransport as unknown as Record<PropertyKey, unknown>)[
            Symbol("unexpected-transport")
          ] = vi.fn();
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SCHEMA" });

    await expect(
      createHarness({
        configureRuntime: (config) => {
          Reflect.deleteProperty(config.brokerTransport, "observeBrokerMailbox");
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SCHEMA" });

    await expect(
      createHarness({
        configureRuntime: (config) => {
          Reflect.deleteProperty(config.controllerTransport, "verifyScenarioActionReceipt");
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_SCHEMA" });
  });

  it("routes broker preflight observation only through the separate broker transport", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });

    const readersInput = runtimeMocks.createPreflightReaders.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(readersInput.observeBrokerMailbox).toBe(harness.observeBrokerMailbox);
    expect(readersInput.observeGuest).not.toBe(harness.observeBrokerMailbox);
  });

  it("exports the exact deterministic scenario operation identity", () => {
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const first = deriveProbeRuntimeScenarioOperationId(command, "capture-home-identity");
    expect(first).toMatch(/^operation-[a-f0-9]{32}$/u);
    expect(deriveProbeRuntimeScenarioOperationId(command, "capture-home-identity")).toBe(first);
    expect(deriveProbeRuntimeScenarioOperationId(command, "another-action")).not.toBe(first);
    expect(
      deriveProbeRuntimeScenarioOperationId({ ...command, repetition: 1 }, "capture-home-identity"),
    ).not.toBe(first);
    expect(() =>
      deriveProbeRuntimeScenarioOperationId({ ...command, repetition: 0 }, "capture-home-identity"),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_ACTION_OPERATION" }));
  });

  it("rejects a planted controller result without provenance and never invokes the action", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const item = workItem(command);
    const paths = probeSegmentArtifactPaths(item);
    await ensureDirectory(harness.store, paths.evidence);
    const proof = await harness.store.writeCanonicalJson(
      `${paths.evidence}/planted-controller-result.json`,
      { planted: true },
    );
    const actionId = "prepare-home-topology";
    const resultPath = deriveProbeRuntimeActionPaths(command, actionId).operationResultPath;
    await ensureDirectory(harness.store, resultPath.split("/").slice(0, -1).join("/"));
    await harness.store.writeCanonicalJson(resultPath, {
      actionId,
      commandEvent: null,
      evidenceArtifacts: [{ path: proof.path, sha256: proof.sha256 }],
    });

    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "CONTROLLER_ACTION_PROVENANCE_MISSING" });
    expect(harness.invokeControllerAction).not.toHaveBeenCalled();
    expect(harness.verifyActionReceipt).toHaveBeenCalledTimes(1);
    expect(harness.actionOperations).toEqual([]);
  });

  it("invokes a fresh controller action once and then verifies its retained receipt", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    await harness.runtime.segment({
      command,
      plan: PROBE_RUN_PLAN,
      workItem: workItem(command),
    });

    expect(harness.invokeControllerAction).toHaveBeenCalledTimes(1);
    expect(harness.verifyActionReceipt).toHaveBeenCalledTimes(1);
    expect(harness.invokeControllerAction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.verifyActionReceipt.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("rejects a malformed expanded controller acknowledgment", async () => {
    const harness = await createHarness({
      configureRuntime: (config) => {
        const invoke = config.controllerTransport.invokeScenarioAction;
        Object.defineProperty(config.controllerTransport, "invokeScenarioAction", {
          configurable: true,
          enumerable: true,
          value: async (input: ProbeRuntimeActionInput) => ({
            ...(await invoke(input)),
            unexpected: true,
          }),
        });
      },
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");

    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: workItem(command) }),
    ).rejects.toMatchObject({ code: "RUNTIME_SCHEMA" });
    expect(harness.invokeControllerAction).toHaveBeenCalledTimes(1);
    expect(harness.verifyActionReceipt).toHaveBeenCalledTimes(1);
  });

  it("rejects a raw attestation artifact SHA substituted into a controller acknowledgment", async () => {
    let harness: Harness;
    harness = await createHarness({
      memoryEvidenceStore: true,
      configureRuntime: (config) => {
        const invoke = config.controllerTransport.invokeScenarioAction;
        Object.defineProperty(config.controllerTransport, "invokeScenarioAction", {
          configurable: true,
          enumerable: true,
          value: async (input: ProbeRuntimeActionInput) => {
            const acknowledgment = await invoke(input);
            if (acknowledgment.actionAttestationSha256 === null) return acknowledgment;
            const coordinate = {
              campaignRunId: input.command.campaignRunId,
              executionRunId: input.preparedContext.executionRunId,
              attemptId: input.command.attemptId,
              workId: input.command.workId,
              environmentId: input.command.environmentId,
              pathProfileId: input.command.pathProfileId,
              rowId: input.command.rowId,
              variantId: input.command.variantId,
              repetition: input.command.repetition ?? null,
            };
            const artifact = await harness.store.readArtifact(
              probeControllerActionAttestationPath({
                coordinate,
                producerActionId: input.invocation.action.actionId,
              }),
            );
            expect(artifact.sha256).not.toBe(acknowledgment.actionAttestationSha256);
            return { ...acknowledgment, actionAttestationSha256: artifact.sha256 };
          },
        });
      },
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-06", "f06-baseline-after-flush-share-allows-replace");

    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: workItem(command) }),
    ).rejects.toMatchObject({ code: "RUNTIME_ACTION_ACKNOWLEDGMENT" });
  });

  it("retains a verified observer from a commandless controller action without native replay", async () => {
    const observerTranscriptSha256 = sha("a");
    const actionId = "prepare-home-topology";
    const harness = await createHarness({
      primaryObserverTranscriptSha256sByAction: {
        [actionId]: [observerTranscriptSha256],
      },
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const item = workItem(command);
    await harness.retainControllerObserverTranscript(item, observerTranscriptSha256);
    await harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item });

    const paths = probeSegmentArtifactPaths(item);
    const sourceTranscript = JSON.parse(
      (await harness.store.readArtifact(paths.sourceTranscript)).bytes.toString("utf8"),
    ) as {
      nativeTranscripts: { transcriptSha256: string }[];
      observerNativeTranscriptSha256s: string[];
      commandEvents: { nativeTranscriptSha256s: string[] }[];
    };
    expect(
      sourceTranscript.nativeTranscripts.map(({ transcriptSha256 }) => transcriptSha256).sort(),
    ).toEqual([nativeTranscriptSha256, observerTranscriptSha256].sort());
    expect(sourceTranscript.observerNativeTranscriptSha256s).toEqual([observerTranscriptSha256]);
    expect(sourceTranscript.commandEvents[0].nativeTranscriptSha256s).toEqual([
      nativeTranscriptSha256,
    ]);
    const controllerResultPath = deriveProbeRuntimeActionPaths(
      command,
      actionId,
    ).operationResultPath;
    expect(
      JSON.parse((await harness.store.readArtifact(controllerResultPath)).bytes.toString("utf8")),
    ).toMatchObject({ commandEvent: null });
    expect(
      harness.readNativeTranscript.mock.calls.some(
        ([input]) => input.transcriptSha256 === observerTranscriptSha256,
      ),
    ).toBe(false);
  });

  it("rejects a recovered observer classification that differs from reverified action provenance", async () => {
    const observerTranscriptSha256 = sha("a");
    const changedObserverTranscriptSha256 = sha("b");
    const actionId = "prepare-home-topology";
    let changeVerifiedObserver = false;
    const harness = await createHarness({
      primaryObserverTranscriptSha256sByAction: {
        [actionId]: [observerTranscriptSha256],
      },
      configureRuntime: (config) => {
        const verify = config.controllerTransport.verifyScenarioActionReceipt;
        Object.defineProperty(config.controllerTransport, "verifyScenarioActionReceipt", {
          configurable: true,
          enumerable: true,
          value: async (input: ProbeRuntimeActionInput) => {
            const acknowledgment = await verify(input);
            return changeVerifiedObserver
              ? {
                  ...acknowledgment,
                  primaryObserverTranscriptSha256s: [changedObserverTranscriptSha256],
                }
              : acknowledgment;
          },
        });
      },
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const item = workItem(command);
    await harness.retainControllerObserverTranscript(item, observerTranscriptSha256);
    await harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item });
    changeVerifiedObserver = true;

    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONTROLLER_OBSERVER_TRANSCRIPT" });
  });

  it("reverifies every ordinary controller action before a recovered transcript can return", async () => {
    let rejectRecovery = false;
    const harness = await createHarness({
      configureRuntime: (config) => {
        const verify = config.controllerTransport.verifyScenarioActionReceipt;
        Object.defineProperty(config.controllerTransport, "verifyScenarioActionReceipt", {
          configurable: true,
          enumerable: true,
          value: async (input: ProbeRuntimeActionInput) => {
            if (rejectRecovery) {
              throw Object.assign(new Error("retained provenance is no longer valid"), {
                code: "CONTROLLER_ACTION_PROVENANCE_INVALID",
              });
            }
            return verify(input);
          },
        });
      },
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const item = workItem(command);
    await harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item });
    const invocationCount = harness.invokeControllerAction.mock.calls.length;
    rejectRecovery = true;

    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "CONTROLLER_ACTION_PROVENANCE_INVALID" });
    expect(harness.invokeControllerAction).toHaveBeenCalledTimes(invocationCount);
  });

  it("rejects a native transcript before its helper reaches a terminal state", async () => {
    const harness = await createHarness({ nativeTermination: null });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: workItem(command) }),
    ).rejects.toMatchObject({ code: "RUNTIME_NATIVE_TRANSCRIPT" });
  });

  it.each([
    [
      "native candidate digest",
      {
        transcriptNativeCandidateDigest: sha("b"),
        retainedNativeTranscriptSha256: sha("c"),
      },
    ],
    [
      "native manifest digest",
      {
        transcriptNativeManifestSha256: sha("b"),
        retainedNativeTranscriptSha256: sha("d"),
      },
    ],
  ] as const)(
    "rejects recomputed native transcripts that substitute the %s build identity",
    async (_identity, substitution) => {
      const harness = await createHarness(substitution);
      await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
      const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
      await expect(
        harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: workItem(command) }),
      ).rejects.toMatchObject({ code: "RUNTIME_NATIVE_TRANSCRIPT" });
    },
  );

  it("retains ordinary transcripts and continuations exactly across retries", async () => {
    const harness = await createHarness();
    expect(harness.runtime).toMatchObject({
      scenarioTransportMode: "injected-authoritative-lab",
      operationMappingStatus: "audited-action-map-bundled",
      disruptiveActionBoundary: "external-controller-request-and-receipt-only",
    });
    const prepare = prepareCommand();
    await expect(
      harness.runtime.prepare({ command: prepare, plan: PROBE_RUN_PLAN }),
    ).resolves.toMatchObject({ recovered: false });
    await expect(
      harness.runtime.prepare({ command: prepare, plan: PROBE_RUN_PLAN }),
    ).resolves.toMatchObject({ recovered: true });
    expect(runtimeMocks.prepareContext).toHaveBeenCalledTimes(2);
    expect(harness.verifyAuthorization).toHaveBeenCalledTimes(1);

    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const item = workItem(command);
    const first = await harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item });
    expect(harness.actionInputs.length).toBeGreaterThan(0);
    for (const input of harness.actionInputs) {
      const expectedExecution = getProbeActionMapping(input.invocation);
      expect(input.execution).toEqual(expectedExecution);
      const retainedIntent = JSON.parse(
        Buffer.from((await harness.store.readArtifact(input.operationIntentPath)).bytes).toString(
          "utf8",
        ),
      ) as { execution?: unknown };
      expect(retainedIntent.execution).toEqual(expectedExecution);
    }
    const operationCount = harness.actionOperations.length;
    const second = await harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item });
    expect(first.recovered).toBe(false);
    expect(second).toMatchObject({
      recovered: true,
      sourceTranscriptSha256: first.sourceTranscriptSha256,
      sourceTranscriptReceiptSha256: first.sourceTranscriptReceiptSha256,
    });
    expect(harness.actionOperations).toHaveLength(operationCount);
    expect(harness.signer).toHaveBeenCalledTimes(1);
    expect(harness.readNativeTranscript).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.reduceTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedNativeTranscripts: [
          expect.objectContaining({
            transcriptSha256: nativeTranscriptSha256,
            commandRecords: [expect.objectContaining({ command: "home-identity", ok: true })],
          }),
        ],
      }),
    );

    const finalized = await harness.runtime.finalizeSegment({
      command: finalizeSegmentCommand(command.rowId, command.variantId),
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    expect(finalized).toMatchObject({ outcome: "PASS", segmentSha256: sha("e") });
    expect(runtimeMocks.createFinalizerAdapters).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.finalizeSegment.mock.calls[0]?.[0].adapters).toHaveProperty(
      "readNativeClientSource",
    );
    expect(runtimeMocks.finalizeSegment.mock.calls[0]?.[0]).toMatchObject({
      runAuthorization: harness.runAuthorization,
      runAuthorizationClaim: expect.objectContaining({
        authorizationSha256: harness.runAuthorization.authorizationSha256,
      }),
    });
    expect(runtimeMocks.verifyCommittedSegment).toHaveBeenCalledTimes(1);
    await harness.store.writeCanonicalJson(finalized.commitPath, { committed: true });

    const campaign = await harness.runtime.finalizeCampaign({
      command: finalizeCampaignCommand(),
      plan: PROBE_RUN_PLAN,
    });
    expect(campaign).toMatchObject({ authority: "verified-artifact-finalizer", sourceCount: 1 });
    expect(runtimeMocks.finalizeCampaign.mock.calls.at(-1)?.[0].segmentSources).toEqual([
      { store: harness.store, commitPath: finalized.commitPath },
    ]);
  }, 30_000);

  it.each([
    {
      rowId: "F-06",
      variantId: "f06-process-crash-after-flush-share-allows-replace",
      operations: [
        "prepare-replacement-target",
        "arm-replacement-session",
        "terminate-replacement-process",
        "inspect-replacement-after-recovery",
        "atomic-replacement-campaign",
      ],
    },
    {
      rowId: "F-06",
      variantId: "f06-reboot-after-flush-share-allows-replace",
      operations: [
        "prepare-replacement-target",
        "arm-replacement-session",
        "reboot-replacement-guest",
        "inspect-replacement-after-recovery",
        "atomic-replacement-campaign",
      ],
    },
    {
      rowId: "F-10",
      variantId: "f10-kill-after-database-open",
      operations: [
        "prepare-singleton-scenario",
        "arm-singleton-session",
        "kill-singleton-process",
        "inspect-singleton-after-kill",
        "singleton-campaign",
      ],
    },
  ])(
    "runs $variantId inspection before its campaign capture",
    async ({ rowId, variantId, operations }) => {
      const harness = await createHarness();
      await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
      const command = segmentCommand(rowId, variantId);
      await harness.runtime.segment({
        command,
        plan: PROBE_RUN_PLAN,
        workItem: workItem(command),
      });
      expect(harness.actionOperations).toEqual(operations);
    },
    30_000,
  );

  it("hands hard cuts outward and resumes only from retained signed receipts", async () => {
    const harness = await createHarness({ memoryEvidenceStore: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const segment = segmentCommand("F-07", "f07-hard-cut-after-file-flush");
    const item = workItem(segment);
    await expect(
      harness.runtime.segment({ command: segment, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "RUNTIME_HARD_CUT_PENDING" });

    for (let repetition = 1; repetition <= 5; repetition += 1) {
      const checkpoint = continuationCommand("checkpoint", repetition);
      const firstRequest = await harness.runtime.checkpoint({
        command: checkpoint,
        plan: PROBE_RUN_PLAN,
        workItem: item,
      });
      expect(firstRequest).toMatchObject({
        authority: "external-controller-action-required",
        transportMode: "request-only-no-disruptive-action",
        actionRequired: true,
        repetition,
      });
      if (repetition === 1) {
        const repeatedIntent = JSON.parse(
          Buffer.from(
            (
              await harness.store.readArtifact(
                [
                  "runtime",
                  "work",
                  checkpoint.campaignRunId,
                  checkpoint.attemptId,
                  checkpoint.workId,
                  "action-intents",
                  "start-durability-operation-r1.json",
                ].join("/"),
              )
            ).bytes,
          ).toString("utf8"),
        ) as { repetition?: unknown };
        expect(repeatedIntent.repetition).toBe(1);
        const operationCount = harness.actionOperations.length;
        const retried = await harness.runtime.checkpoint({
          command: checkpoint,
          plan: PROBE_RUN_PLAN,
          workItem: item,
        });
        expect(retried).toMatchObject({
          authority: "external-controller-action-pending",
          transportMode: "pending-action-no-repeat",
          actionRequired: false,
          recovered: true,
          requestSha256: firstRequest.requestSha256,
        });
        expect(harness.actionOperations).toHaveLength(operationCount);
      }
      const resume = continuationCommand("resume", repetition);
      const resumed = await harness.runtime.resume({
        command: resume,
        plan: PROBE_RUN_PLAN,
        workItem: item,
      });
      expect(resumed).toMatchObject({
        authority: "verified-external-controller-receipt",
        transportMode: "receipt-read-only",
        repetition,
        captureReady: repetition === 5,
      });
      if (repetition === 1) {
        const operationCount = harness.actionOperations.length;
        const retried = await harness.runtime.resume({
          command: resume,
          plan: PROBE_RUN_PLAN,
          workItem: item,
        });
        expect(retried.receiptSha256).toBe(resumed.receiptSha256);
        expect(harness.actionOperations).toHaveLength(operationCount);
        await expect(
          harness.runtime.checkpoint({
            command: checkpoint,
            plan: PROBE_RUN_PLAN,
            workItem: item,
          }),
        ).resolves.toMatchObject({
          authority: "verified-external-controller-receipt",
          transportMode: "completed-no-action",
          actionRequired: false,
        });
      }
    }

    expect(harness.claimRequest).toHaveBeenCalledTimes(5);
    expect(harness.readReceipt).toHaveBeenCalledTimes(5);
    let expectedPreCutBootIdSha256 = sha("1");
    for (const [index, call] of harness.claimRequest.mock.calls.entries()) {
      expect(call[0].preCutBootIdSha256).toBe(expectedPreCutBootIdSha256);
      expectedPreCutBootIdSha256 = harness.postBootIds[index];
    }
    expect(harness.postBootIds).toHaveLength(5);
    expect(harness.actionOperations).not.toContain("hard-cut-guest");
    expect(harness.actionOperations).toEqual([
      "prepare-durability-target",
      ...Array.from({ length: 5 }, () => [
        "start-durability-operation",
        "start-guest-after-hard-cut",
        "inspect-durability-after-hard-cut",
      ]).flat(),
      "durability-campaign",
    ]);
    const sourceTranscript = JSON.parse(
      (
        await harness.store.readArtifact(probeSegmentArtifactPaths(item).sourceTranscript)
      ).bytes.toString("utf8"),
    ) as { observerNativeTranscriptSha256s: string[] };
    const hardCutObserverTranscriptSha256s = Array.from({ length: 5 }, (_, index) =>
      createHash("sha256")
        .update(`hard-cut-observer:${index + 1}`, "utf8")
        .digest("hex"),
    ).sort();
    expect(sourceTranscript.observerNativeTranscriptSha256s).toEqual(
      hardCutObserverTranscriptSha256s,
    );
    for (const transcriptSha256 of hardCutObserverTranscriptSha256s) {
      expect(
        harness.readNativeTranscript.mock.calls.some(
          ([input]) => input.transcriptSha256 === transcriptSha256,
        ),
      ).toBe(false);
    }
    const beforeRecoveryVerification = harness.verifyHardCutReceipt.mock.calls.length;
    await expect(
      harness.runtime.segment({ command: segment, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ recovered: true, authority: "retained-signed-transcript" });
    expect(
      harness.verifyHardCutReceipt.mock.calls.length - beforeRecoveryVerification,
    ).toBeGreaterThanOrEqual(5);
    const beforeFinalizationVerification = harness.verifyHardCutReceipt.mock.calls.length;
    await harness.runtime.finalizeSegment({
      command: finalizeSegmentCommand(segment.rowId, segment.variantId),
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    expect(
      harness.verifyHardCutReceipt.mock.calls.length - beforeFinalizationVerification,
    ).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it("requires both ordered hard-cut recovery captures before the next checkpoint", async () => {
    const harness = await createHarness({
      failActionCaptureForActionOnce: "inspect-durability-after-hard-cut-r1",
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const item = workItem(segmentCommand("F-07", "f07-hard-cut-after-file-flush"));
    const firstCheckpoint = continuationCommand("checkpoint", 1);
    await harness.runtime.checkpoint({
      command: firstCheckpoint,
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    const firstResume = continuationCommand("resume", 1);
    await expect(
      harness.runtime.resume({ command: firstResume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(harness.actionOperations.slice(-2)).toEqual([
      "start-guest-after-hard-cut",
      "inspect-durability-after-hard-cut",
    ]);

    await expect(
      harness.runtime.checkpoint({
        command: continuationCommand("checkpoint", 2),
        plan: PROBE_RUN_PLAN,
        workItem: item,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_ACTION_CAPTURE_MISSING" });

    await expect(
      harness.runtime.resume({ command: firstResume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });
    await expect(
      harness.runtime.checkpoint({
        command: continuationCommand("checkpoint", 2),
        plan: PROBE_RUN_PLAN,
        workItem: item,
      }),
    ).resolves.toMatchObject({ repetition: 2 });
  }, 30_000);

  it("rejects a retained action intent that rewrites its originating repetition", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const segment = segmentCommand("F-07", "f07-hard-cut-after-file-flush");
    const item = workItem(segment);
    const checkpoint = continuationCommand("checkpoint", 1);
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    await harness.runtime.resume({
      command: continuationCommand("resume", 1),
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });

    const actionId = "prepare-durability-target";
    const intentPath = [
      "runtime",
      "work",
      checkpoint.campaignRunId,
      checkpoint.attemptId,
      checkpoint.workId,
      "action-intents",
      `${actionId}.json`,
    ].join("/");
    const artifact = await harness.store.readArtifact(intentPath);
    const retainedIntent = JSON.parse(artifact.bytes.toString("utf8"));
    const rewrittenRepetition = 2;
    const rewrittenOperationId = deriveProbeRuntimeScenarioOperationId(
      { ...checkpoint, repetition: rewrittenRepetition },
      actionId,
    );
    await writeFile(
      join(harness.store.root, ...intentPath.split("/")),
      canonicalProbeJson({
        ...retainedIntent,
        repetition: rewrittenRepetition,
        operationId: rewrittenOperationId,
      }),
    );

    await expect(
      harness.runtime.checkpoint({
        command: continuationCommand("checkpoint", 2),
        plan: PROBE_RUN_PLAN,
        workItem: item,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_ACTION_CAPTURE" });
  }, 30_000);

  it("reuses an exact retained claim after expiry while refusing a new expired claim", async () => {
    const retainedState = signedControllerState();
    const retainedHarness = await createHarness({ controllerState: retainedState });
    const command = prepareCommand();
    await retainedHarness.runtime.prepare({ command, plan: PROBE_RUN_PLAN });
    retainedState.verificationInstant = retainedHarness.runAuthorization.expiresAt;
    await expect(
      retainedHarness.runtime.prepare({ command, plan: PROBE_RUN_PLAN }),
    ).resolves.toMatchObject({ recovered: true });
    expect(retainedHarness.verifyAuthorization).toHaveBeenCalledTimes(1);

    const newState = signedControllerState();
    newState.verificationInstant = retainedHarness.runAuthorization.expiresAt;
    const newHarness = await createHarness({ controllerState: newState });
    await expect(
      newHarness.runtime.prepare({ command, plan: PROBE_RUN_PLAN }),
    ).rejects.toMatchObject({ code: "RUN_AUTH_EXPIRED" });
  }, 30_000);

  it("rejects caller-supplied work-item drift before a hard-cut action can run", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-07", "f07-hard-cut-after-file-flush");
    const trusted = workItem(command);
    await expect(
      harness.runtime.segment({
        command,
        plan: PROBE_RUN_PLAN,
        workItem: { ...trusted, requiresExternalCheckpoint: false },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_DISPATCH_WORK_ITEM" });
    expect(harness.actionOperations).not.toContain("hard-cut-guest");
  });

  it("rejects a forged controller request before retaining or exposing it", async () => {
    const controllerState = signedControllerState();
    controllerState.forgeNextRequestSignature = true;
    const harness = await createHarness({ controllerState });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", command.variantId));
    await expect(
      harness.runtime.checkpoint({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "SEGMENT_CHECKPOINT_SIGNATURE" });
    await expect(
      harness.store.readArtifact(
        `runtime/work/${command.campaignRunId}/${command.attemptId}/${command.workId}/hard-cuts/01-request.json`,
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects a signed receipt that does not prove a new boot identity", async () => {
    const controllerState = signedControllerState();
    controllerState.equalBootReceiptOnce = true;
    const harness = await createHarness({ controllerState });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "SEGMENT_CHECKPOINT_BOOT_TRANSITION" });
  }, 30_000);

  it("replays the exact controller claim after local request publication fails", async () => {
    const harness = await createHarness({ failHardCutRequestWriteOnce: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", command.variantId));
    await expect(
      harness.runtime.checkpoint({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    const recovered = await harness.runtime.checkpoint({
      command,
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    expect(recovered).toMatchObject({ actionRequired: true, recovered: false });
    expect(harness.claimRequest).toHaveBeenCalledTimes(2);
    expect(harness.controllerState.hardCutsByScope.size).toBe(1);
  }, 30_000);

  it("does not retain an invalid controller receipt over an exact retry", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", "f07-hard-cut-after-file-flush"));
    await harness.runtime.checkpoint({ command, plan: PROBE_RUN_PLAN, workItem: item });
    const original = harness.readReceipt.getMockImplementation() as (
      input: ProbeRuntimeHardCutReceiptReadInput,
    ) => Promise<ProbeRuntimeHardCutReceiptReadResult>;
    harness.readReceipt.mockImplementationOnce(
      async (input: ProbeRuntimeHardCutReceiptReadInput) => {
        const result = await original(input);
        return {
          ...result,
          checkpointEvidence: {
            ...result.checkpointEvidence,
            receipt: { ...result.checkpointEvidence.receipt, signatureBase64: "AQ==" },
          },
        };
      },
    );
    const resume = continuationCommand("resume", 1);
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "RUNTIME_CHECKPOINT_EQUIVOCATION" });
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("rejects receipt and provenance equivocation between invocation and offline verification", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const original = harness.verifyHardCutReceipt.getMockImplementation() as (
      input: ProbeRuntimeHardCutReceiptReadInput,
    ) => Promise<ProbeRuntimeHardCutReceiptReadResult>;
    harness.verifyHardCutReceipt.mockImplementationOnce(async (input) => {
      const verified = await original(input);
      return {
        ...verified,
        actionAcknowledgment: {
          ...verified.actionAcknowledgment,
          provenanceSha256: sha("f"),
        },
      };
    });
    const resume = continuationCommand("resume", 1);

    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "RUNTIME_CHECKPOINT_EQUIVOCATION" });
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("does not repeat a hard cut when its action authority is only partially retained", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    const requested = await harness.runtime.checkpoint({
      command: checkpoint,
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    expect(requested.actionRequired).toBe(true);

    const paths = probeControllerActionProvenancePaths({
      campaignRunId: checkpoint.campaignRunId,
      attemptId: checkpoint.attemptId,
      workId: checkpoint.workId,
      producerActionId: "hard-cut-guest-r1",
    });
    await ensureDirectory(harness.store, paths.controllerRequest.split("/").slice(0, -1).join("/"));
    await harness.store.writeCanonicalJson(paths.controllerRequest, {
      interruptedBeforeCommit: true,
    });

    await expect(
      harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({
      actionRequired: false,
      authority: "external-controller-action-pending",
      transportMode: "pending-action-no-repeat",
      recovered: true,
    });
    expect(harness.readReceipt).not.toHaveBeenCalled();

    await expect(
      harness.runtime.resume({
        command: continuationCommand("resume", 1),
        plan: PROBE_RUN_PLAN,
        workItem: item,
      }),
    ).resolves.toMatchObject({
      authority: "verified-external-controller-receipt",
      captureReady: false,
    });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("retains the resume authority before consuming the continuation", async () => {
    const harness = await createHarness({ failHardCutResumeWriteOnce: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", "f07-hard-cut-after-file-flush"));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(
      harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({
      actionRequired: false,
      authority: "verified-external-controller-receipt",
      transportMode: "resume-required-no-action",
      recovered: true,
    });
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("recovers a staged hard-cut result when receipt consumption was interrupted", async () => {
    const harness = await createHarness({ failReceiptTransactionWriteOnce: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", "f07-hard-cut-after-file-flush"));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(
      harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({
      actionRequired: false,
      authority: "verified-external-controller-receipt",
      transportMode: "resume-required-no-action",
      recovered: true,
    });
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("recovers retained signed authority when local hard-cut staging is interrupted", async () => {
    const harness = await createHarness({ failHardCutStagingWriteOnce: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);

    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(
      harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({
      actionRequired: false,
      authority: "verified-external-controller-receipt",
      transportMode: "resume-required-no-action",
      recovered: true,
    });
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });

    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
    expect(harness.postBootIds).toHaveLength(1);
    expect(harness.verifyHardCutReceipt).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("recovers a signed hard-cut result when action-capture publication is interrupted", async () => {
    const harness = await createHarness({
      failActionCaptureForActionOnce: "hard-cut-guest-r1",
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);

    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(
      harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({
      actionRequired: false,
      authority: "verified-external-controller-receipt",
      transportMode: "resume-required-no-action",
      recovered: true,
    });
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });

    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
    expect(harness.postBootIds).toHaveLength(1);
  }, 30_000);

  it("recovers after continuation consumption without repeating the hard cut or post-cut action", async () => {
    const harness = await createHarness({
      failActionCaptureForActionOnce: "start-guest-after-hard-cut-r1",
    });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);

    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(
      harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ actionRequired: false });
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ captureReady: false });

    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
    expect(harness.postBootIds).toHaveLength(1);
    expect(
      harness.actionOperations.filter((operation) => operation === "start-guest-after-hard-cut"),
    ).toHaveLength(1);
  }, 30_000);

  it("rejects two signed staged hard-cut results for one request", async () => {
    const harness = await createHarness({ failReceiptTransactionWriteOnce: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", "f07-hard-cut-after-file-flush"));
    const requested = await harness.runtime.checkpoint({
      command: checkpoint,
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    const resume = continuationCommand("resume", 1);
    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });

    const stagedDirectory = [
      "runtime",
      "work",
      checkpoint.campaignRunId,
      checkpoint.attemptId,
      checkpoint.workId,
      "hard-cuts",
      "staged",
      requested.request.requestSha256,
    ].join("/");
    const [entry] = await harness.store.list(stagedDirectory);
    if (entry === undefined) throw new Error("expected a staged hard-cut result");
    const retained = JSON.parse(
      (await harness.store.readArtifact(`${stagedDirectory}/${entry.name}`)).bytes.toString("utf8"),
    );
    const unsignedReceipt = {
      ...retained.checkpointEvidence.receipt,
      postBootVmSnapshotId: "post-boot-snapshot-equivocation",
      postBootBootIdSha256: sha("9"),
      receiptSha256: "",
      signatureBase64: "",
    };
    const receiptSha256 = deriveExternalCheckpointReceiptDigest(unsignedReceipt);
    const checkpointEvidence = {
      request: requested.request,
      receipt: {
        ...unsignedReceipt,
        receiptSha256,
        signatureBase64: sign(
          null,
          Buffer.from(receiptSha256, "hex"),
          controllerPrivateKey,
        ).toString("base64"),
      },
    };
    const equivocated = { ...retained, checkpointEvidence };
    await harness.store.writeCanonicalJson(
      `${stagedDirectory}/${hashProbeCanonicalJson(equivocated)}.json`,
      equivocated,
    );

    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "RUNTIME_CHECKPOINT_EQUIVOCATION" });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("surfaces retained hard-cut raw-record tampering from the offline verifier", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);
    await harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item });
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: checkpoint.campaignRunId,
      attemptId: checkpoint.attemptId,
      workId: checkpoint.workId,
      producerActionId: "hard-cut-guest-r1",
    });
    await writeFile(
      join(harness.store.root, ...paths.controllerResponse.split("/")),
      canonicalProbeJson({ tampered: true }),
    );

    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "CONTROLLER_HARD_CUT_PROVENANCE_INVALID" });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("rejects a retained hard cut when its signed provenance is missing", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const checkpoint = continuationCommand("checkpoint", 1);
    const item = workItem(segmentCommand("F-07", checkpoint.variantId));
    await harness.runtime.checkpoint({ command: checkpoint, plan: PROBE_RUN_PLAN, workItem: item });
    const resume = continuationCommand("resume", 1);
    await harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item });
    const paths = probeControllerActionProvenancePaths({
      campaignRunId: checkpoint.campaignRunId,
      attemptId: checkpoint.attemptId,
      workId: checkpoint.workId,
      producerActionId: "hard-cut-guest-r1",
    });
    await rm(join(harness.store.root, ...paths.provenance.split("/")));

    await expect(
      harness.runtime.resume({ command: resume, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "CONTROLLER_HARD_CUT_PROVENANCE_MISSING" });
    expect(harness.readReceipt).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("rejects a signed hard-cut action swapped across repetitions and coordinates", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const item = workItem(segmentCommand("F-07", "f07-hard-cut-after-file-flush"));
    for (const repetition of [1, 2]) {
      const checkpoint = continuationCommand("checkpoint", repetition);
      await harness.runtime.checkpoint({
        command: checkpoint,
        plan: PROBE_RUN_PLAN,
        workItem: item,
      });
      await harness.runtime.resume({
        command: continuationCommand("resume", repetition),
        plan: PROBE_RUN_PLAN,
        workItem: item,
      });
    }
    const secondInput = harness.readReceipt.mock.calls.find(
      ([input]) => input.command.repetition === 2,
    )?.[0] as ProbeRuntimeHardCutReceiptReadInput | undefined;
    if (secondInput === undefined) throw new Error("second hard-cut input is missing");
    const original = harness.verifyHardCutReceipt.getMockImplementation() as (
      input: ProbeRuntimeHardCutReceiptReadInput,
    ) => Promise<ProbeRuntimeHardCutReceiptReadResult>;
    harness.verifyHardCutReceipt.mockImplementationOnce(() => original(secondInput));

    await expect(
      harness.runtime.resume({
        command: continuationCommand("resume", 1),
        plan: PROBE_RUN_PLAN,
        workItem: item,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CHECKPOINT_RECEIPT" });
    expect(harness.readReceipt).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("rejects an altered prior repetition before extending the boot chain", async () => {
    const harness = await createHarness();
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const item = workItem(segmentCommand("F-07", "f07-hard-cut-after-file-flush"));
    const firstCheckpoint = continuationCommand("checkpoint", 1);
    await harness.runtime.checkpoint({
      command: firstCheckpoint,
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    await harness.runtime.resume({
      command: continuationCommand("resume", 1),
      plan: PROBE_RUN_PLAN,
      workItem: item,
    });
    const resumePath = `runtime/work/${firstCheckpoint.campaignRunId}/${firstCheckpoint.attemptId}/${firstCheckpoint.workId}/hard-cuts/01-resume.json`;
    const retained = JSON.parse(
      (await harness.store.readArtifact(resumePath)).bytes.toString("utf8"),
    );
    await writeFile(
      join(harness.store.root, ...resumePath.split("/")),
      canonicalProbeJson({
        ...retained,
        actionAcknowledgment: {
          ...retained.actionAcknowledgment,
          provenanceSha256: sha("f"),
        },
      }),
    );

    await expect(
      harness.runtime.checkpoint({
        command: continuationCommand("checkpoint", 2),
        plan: PROBE_RUN_PLAN,
        workItem: item,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CHECKPOINT_EQUIVOCATION" });
    expect(harness.claimRequest).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("recovers a source-only transcript after the receipt write is interrupted", async () => {
    const harness = await createHarness({ failSourceReceiptWriteOnce: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const item = workItem(command);
    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    const operationCount = harness.actionOperations.length;
    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ recovered: true });
    expect(harness.actionOperations).toHaveLength(operationCount);
    expect(harness.signer).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("does not repeat an action after its durable result outlives capture publication", async () => {
    const harness = await createHarness({ failActionCaptureWriteOnce: true });
    await harness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN });
    const command = segmentCommand("F-01", "f01-ordinary-absolute-path");
    const item = workItem(command);
    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(harness.actionOperations).toEqual(["prepare-home-topology"]);
    expect(harness.invokeControllerAction).toHaveBeenCalledTimes(1);
    expect(harness.verifyActionReceipt).toHaveBeenCalledTimes(1);
    await expect(
      harness.runtime.segment({ command, plan: PROBE_RUN_PLAN, workItem: item }),
    ).resolves.toMatchObject({ recovered: false });
    expect(
      harness.actionOperations.filter((operation) => operation === "prepare-home-topology"),
    ).toHaveLength(1);
    expect(harness.invokeControllerAction).toHaveBeenCalledTimes(1);
    expect(harness.verifyActionReceipt).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("rejects a concurrent nonce collision through one controller across distinct stores", async () => {
    const controllerState = signedControllerState();
    controllerState.forceNonceSha256 = sha("b");
    const firstHarness = await createHarness({ controllerState });
    const secondHarness = await createHarness({ controllerState });
    await Promise.all([
      firstHarness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN }),
      secondHarness.runtime.prepare({ command: prepareCommand(), plan: PROBE_RUN_PLAN }),
    ]);
    const first = continuationCommand("checkpoint", 1);
    const second = continuationCommand("checkpoint", 1, "f07-hard-cut-after-namespace-replace");
    const results = await Promise.allSettled([
      firstHarness.runtime.checkpoint({
        command: first,
        plan: PROBE_RUN_PLAN,
        workItem: workItem(segmentCommand("F-07", first.variantId)),
      }),
      secondHarness.runtime.checkpoint({
        command: second,
        plan: PROBE_RUN_PLAN,
        workItem: workItem(segmentCommand("F-07", second.variantId)),
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "CONTROLLER_HARD_CUT_REPLAY" }),
    });
    expect(controllerState.nonceOwners.size).toBe(1);
    expect(firstHarness.store.root).not.toBe(secondHarness.store.root);
  }, 30_000);
});
