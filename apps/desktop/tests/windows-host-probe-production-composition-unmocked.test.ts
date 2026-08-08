import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dispatchWindowsHostFalsifierCommand } from "../scripts/windows-host-falsifier.mjs";
import type { ControllerSpoolClient } from "../scripts/windows-host-falsifier/controller/spool.mjs";
import {
  openEvidenceStore,
  type EvidenceStore,
} from "../scripts/windows-host-falsifier/evidence-store.mjs";
import {
  buildNativeHelper,
  loadNativeHelper,
  type NativeBuild,
} from "../scripts/windows-host-falsifier/native-client.mjs";
import { createProbeAuthoritativeRuntime } from "../scripts/windows-host-falsifier/probe-authoritative-runtime.mjs";
import { createProbeBrokerEnrollment } from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { PROBE_BROKER_ROLES } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  loadProbeBootstrap,
  type ProbeBootstrapDocument,
  type ProbeNativeCandidateManifest,
} from "../scripts/windows-host-falsifier/probe-bootstrap.mjs";
import {
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
  deriveCandidateDigest,
  deriveLabAttestationDigest,
  type ProbeCandidateDigestFields,
  type ProbeCandidateIdentity,
  type ProbeLabAttestation,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { createProbeControllerSpoolTransport } from "../scripts/windows-host-falsifier/probe-controller-spool-transport.mjs";
import { createProbeNativeLane } from "../scripts/windows-host-falsifier/probe-native-lane.mjs";
import { PROBE_NATIVE_ROW_DRIVERS } from "../scripts/windows-host-falsifier/probe-native-row-drivers.mjs";
import type { ProbeLifecyclePolicy } from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import {
  createAuthoritativeProbeComposition,
  type ProbeProductionLaneContext,
} from "../scripts/windows-host-falsifier/probe-production-composition.mjs";
import {
  deriveProbeRunAuthorizationDigest,
  type ProbeRunAuthorization,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import { deriveNativeManifestDigests } from "../scripts/windows-host-falsifier/native-manifest-digest.mjs";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const controllerKeyPair = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeyPair.publicKey.export({
  format: "der",
  type: "spki",
});
const controllerPublicKeySha256 = sha256(controllerPublicKeyBytes);
const controllerIdentitySha256 = sha256("unmocked-controller-identity");

interface BootstrapLayout {
  readonly repositoryRoot: string;
  readonly binaryRoot: string;
  readonly evidenceRoots: readonly string[];
  readonly controllerSpoolRoot: string;
  readonly brokerMailboxRoots: readonly string[];
  readonly brokerJournalRoots: readonly string[];
}

interface BootstrapFixture {
  readonly root: string;
  readonly expectedSha256: string;
  readonly bootstrap: ProbeBootstrapDocument;
  readonly candidate: ProbeCandidateIdentity;
  readonly nativeManifest: ProbeNativeCandidateManifest;
}

const cleanupRoots: string[] = [];

function sortedArtifacts(values: Array<{ readonly path: string; readonly sha256: string }>) {
  return values.sort((left, right) =>
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")),
  );
}

function candidate(
  nativeHelperArtifactPath: string,
  nativeAssemblySha256: string,
  toolchain?: ProbeNativeCandidateManifest["toolchain"],
): ProbeCandidateIdentity {
  const fields: ProbeCandidateDigestFields = {
    schemaVersion: 1,
    kind: "windows-host-probe-candidate",
    repositoryCommit: "c".repeat(40),
    sourceHashes: [
      { path: "probe/native-helper.cs", sha256: sha256("native-source") },
      { path: "probe/runner.mjs", sha256: sha256("runner-source") },
    ],
    binaryHashes: sortedArtifacts([
      { path: nativeHelperArtifactPath, sha256: nativeAssemblySha256 },
      { path: "zz-nsis.exe", sha256: sha256("nsis") },
    ]),
    compiler: {
      provider: "Microsoft.CSharp.CSharpCodeProvider",
      codeDomProviderAssemblyVersion: toolchain?.codeDomProviderAssemblyVersion ?? "4.0.0.0",
      cscFileVersion: toolchain?.cscFileVersion ?? "4.8.9256.0",
      cscSha256: toolchain?.cscSha256Before ?? sha256("csc"),
      outputType: "ConsoleApplication",
      platform: "x64",
    },
    toolchain: {
      nodeVersion: process.versions.node,
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      powerShellVersion: toolchain?.powerShellVersion ?? "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256:
        toolchain?.powerShellExecutableSha256Before ?? sha256("powershell"),
      clrVersion: toolchain?.clrVersion ?? "v4.0.30319",
      runtimeDirectorySha256Before: toolchain?.runtimeDirectorySha256Before ?? sha256("runtime"),
      runtimeDirectorySha256After: toolchain?.runtimeDirectorySha256After ?? sha256("runtime"),
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
    configurationSha256: sha256("configuration"),
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
      patchLevel: "synthetic-unmocked-composition-fixture",
      productType: "workstation",
      machineArchitecture: "x64",
      processArchitecture: "x64",
      systemVolumeFileSystem: "NTFS",
      systemVolumeIdSha256: sha256("system-volume"),
      testVolumeFileSystem: "NTFS",
      testVolumeIdSha256: sha256("test-volume"),
      standardUserSidSha256: sha256("standard-user"),
      elevated: false,
      defenderRealtimeEnabled: true,
      uacDefault: true,
      developerModeEnabled: false,
    },
    snapshot: {
      vmImageId: `${environmentId}-image`,
      vmImageSha256: sha256(`${environmentId}-image`),
      vmSnapshotId: `${environmentId}-clean-snapshot`,
      cleanImageVersion: "2026.08.07.1",
    },
    runner: {
      version: "2.329.0",
      labels: [
        "enduragent-falsifier",
        "self-hosted",
        environmentId,
        "windows",
        "windows-11",
        "x64",
      ],
      interactiveSessionOwnerSidSha256: sha256("standard-user"),
    },
    runtime: {
      nodeVersion: process.versions.node,
      powerShellVersion: "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256: sha256("powershell"),
      clrVersion: "v4.0.30319",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      nsisExecutableSha256: sha256("nsis"),
    },
    controller: {
      identitySha256: controllerIdentitySha256,
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
          sha256: sha256(`${environmentId}-ascii-guest`),
        },
      },
      {
        pathProfileId: "spaces-unicode",
        artifact: {
          path: `attestations/${environmentId}-spaces-unicode-guest.json`,
          sha256: sha256(`${environmentId}-spaces-unicode-guest`),
        },
      },
    ],
    controllerEvidence: {
      path: `attestations/${environmentId}-controller.json`,
      sha256: sha256(`${environmentId}-controller`),
    },
  };
  return { ...fields, attestationSha256: deriveLabAttestationDigest(fields) };
}

function authorization(
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
      .sort((left, right) =>
        Buffer.from(left.environmentId, "utf8").compare(Buffer.from(right.environmentId, "utf8")),
      ),
    issuedAt: "2026-08-07T00:00:00.000Z",
    expiresAt: "2026-08-08T00:00:00.000Z",
    operatorKeyId: "operator-one",
    trustStoreId: "windows-lab-operators",
    trustStoreGeneration: 1,
    signatureAlgorithm: "Ed25519" as const,
  };
  return {
    ...unsigned,
    authorizationSha256: deriveProbeRunAuthorizationDigest(unsigned),
    signatureBase64: Buffer.alloc(64, 7).toString("base64"),
  };
}

function lifecyclePolicy(): ProbeLifecyclePolicy {
  return {
    policyId: "windows-client-lifecycle-2026-08",
    evaluatedAt: "2026-08-07T00:00:00.000Z",
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
}

function syntheticNativeManifest(): ProbeNativeCandidateManifest {
  const sourceDigests = [
    { name: "FileSystem.cs", sha256: sha256("FileSystem.cs") },
    { name: "JobObject.cs", sha256: sha256("JobObject.cs") },
    { name: "NamedPipe.cs", sha256: sha256("NamedPipe.cs") },
    { name: "Program.cs", sha256: sha256("Program.cs") },
    { name: "Protocol.cs", sha256: sha256("Protocol.cs") },
  ];
  const references = [
    { name: "System.dll", sha256: sha256("System.dll") },
    { name: "System.Core.dll", sha256: sha256("System.Core.dll") },
    { name: "System.Security.dll", sha256: sha256("System.Security.dll") },
    { name: "System.Web.Extensions.dll", sha256: sha256("System.Web.Extensions.dll") },
  ];
  const sources = sourceDigests.map((entry) => ({ ...entry, bytes: 1024 }));
  const toolchain = {
    schemaVersion: 1 as const,
    powerShellVersion: "5.1.26100.7705",
    powerShellEdition: "Desktop" as const,
    clrVersion: "4.8.0",
    codeDomProvider: "Microsoft.CSharp.CSharpCodeProvider" as const,
    codeDomProviderAssemblyVersion: "4.0.0.0",
    cscFileVersion: "4.8.9256.0",
    cscSha256Before: sha256("csc"),
    cscSha256After: sha256("csc"),
    powerShellExecutableSha256Before: sha256("powershell"),
    powerShellExecutableSha256After: sha256("powershell"),
    runtimeDirectorySha256Before: sha256("runtime"),
    runtimeDirectorySha256After: sha256("runtime"),
    runtimeRelativeInventory: [
      "System.Core.dll",
      "System.Security.dll",
      "System.Web.Extensions.dll",
      "System.dll",
      "csc.exe",
    ],
    outputType: "ConsoleApplication" as const,
    platform: "x64" as const,
    compilerOptions: "/noconfig /nostdlib+ /platform:x64 /target:exe",
    referencedAssemblies: references.map((entry) => entry.name),
    referenceSha256Before: references,
    referenceSha256After: references,
    addTypeInvocation: "Add-Type -OutputType ConsoleApplication",
    sourceSha256Before: sourceDigests,
    sourceSha256After: sourceDigests,
    assemblySha256: sha256("native-assembly"),
  };
  return {
    schemaVersion: 1,
    ...deriveNativeManifestDigests({
      sources,
      toolchain,
      assemblySha256: toolchain.assemblySha256,
    }),
    assembly: {
      name: "windows-host-falsifier-native.exe",
      sha256: toolchain.assemblySha256,
    },
    sources,
    toolchain,
  };
}

async function writeBytes(root: string, path: string, bytes: Uint8Array | string) {
  const absolutePath = join(root, ...path.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
}

async function writeCanonical(root: string, path: string, value: unknown) {
  const bytes = canonicalProbeJson(value);
  await writeBytes(root, path, bytes);
  return { path, sha256: sha256(bytes) };
}

async function createBootstrapFixture(
  root: string,
  layout: BootstrapLayout,
  nativeManifest: ProbeNativeCandidateManifest,
  nativeHelperArtifactPath = "bin/windows-host-falsifier-native.exe",
): Promise<BootstrapFixture> {
  const identity = candidate(
    nativeHelperArtifactPath,
    nativeManifest.assembly.sha256,
    nativeManifest.toolchain,
  );
  const attestations = PROBE_ENVIRONMENT_IDS.map((environmentId) => attestation(environmentId));
  const runAuthorization = authorization(identity, attestations);
  const paths = {
    candidate: "inventory/candidate.json",
    floor: "inventory/attestation-floor.json",
    current: "inventory/attestation-current.json",
    authorization: "inventory/run-authorization.json",
    lifecycle: "inventory/lifecycle-policy.json",
    native: "inventory/native-candidate.json",
    controllerPublicKey: "attestations/controller-public-key.spki.der",
  };
  const [candidateReference, floorReference, currentReference, authorizationReference] =
    await Promise.all([
      writeCanonical(root, paths.candidate, identity),
      writeCanonical(root, paths.floor, attestations[0]),
      writeCanonical(root, paths.current, attestations[1]),
      writeCanonical(root, paths.authorization, runAuthorization),
    ]);
  const [lifecycleReference, nativeReference] = await Promise.all([
    writeCanonical(root, paths.lifecycle, lifecyclePolicy()),
    writeCanonical(root, paths.native, nativeManifest),
  ]);
  await writeBytes(root, paths.controllerPublicKey, controllerPublicKeyBytes);
  const bootstrap: ProbeBootstrapDocument = {
    schemaVersion: 1,
    kind: "windows-host-probe-bootstrap",
    campaignId: "f01-f10-native-probe-v1",
    campaignRunId: "campaign-run-one",
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidate: candidateReference,
    attestations: [
      { environmentId: "win11-floor", artifact: floorReference },
      { environmentId: "win11-current", artifact: currentReference },
    ],
    runAuthorization: authorizationReference,
    lifecyclePolicy: lifecycleReference,
    nativeCandidateManifest: nativeReference,
    candidateBinaries: {
      nativeHelperArtifactPath,
      nsisArtifactPath: "zz-nsis.exe",
    },
    repositoryRoot: layout.repositoryRoot,
    binaryRoot: layout.binaryRoot,
    evidenceRoots: PROBE_ENVIRONMENT_IDS.flatMap((environmentId, environmentIndex) =>
      PROBE_PATH_PROFILE_IDS.map((pathProfileId, pathIndex) => ({
        environmentId,
        pathProfileId,
        root: layout.evidenceRoots[environmentIndex * PROBE_PATH_PROFILE_IDS.length + pathIndex],
      })),
    ),
    controllerSpool: {
      root: layout.controllerSpoolRoot,
      identitySha256: controllerIdentitySha256,
      publicKeySha256: controllerPublicKeySha256,
      version: "1.2.3",
    },
    brokerEnrollments: PROBE_ENVIRONMENT_IDS.flatMap((environmentId, environmentIndex) =>
      PROBE_BROKER_ROLES.map((brokerRole, roleIndex) =>
        createProbeBrokerEnrollment({
          environmentId,
          brokerRole,
          brokerInstanceId: `${environmentId}-${brokerRole}-broker`,
          mailboxRoot:
            layout.brokerMailboxRoots[environmentIndex * PROBE_BROKER_ROLES.length + roleIndex],
          mailboxAclSha256: sha256(`${environmentId}:${brokerRole}:mailbox-acl`),
          journalRoot:
            layout.brokerJournalRoots[environmentIndex * PROBE_BROKER_ROLES.length + roleIndex],
          journalRootAclSha256: sha256(`${environmentId}:${brokerRole}:journal-root-acl`),
          journalDatabaseAclSha256: sha256(`${environmentId}:${brokerRole}:journal-database-acl`),
          processSidSha256:
            brokerRole === "primary-standard-user"
              ? sha256("standard-user")
              : sha256(`${environmentId}:${brokerRole}:process-sid`),
          peerAuthoritySha256:
            brokerRole === "remote-peer"
              ? sha256(`${environmentId}:${brokerRole}:peer-authority`)
              : null,
        }),
      ),
    ),
  };
  const bootstrapBytes = canonicalProbeJson(bootstrap);
  await writeBytes(root, "bootstrap.json", bootstrapBytes);
  return {
    root,
    expectedSha256: sha256(bootstrapBytes),
    bootstrap,
    candidate: identity,
    nativeManifest,
  };
}

function syntheticLayout(): BootstrapLayout {
  return {
    repositoryRoot: "C:\\CompositionSmoke\\Repository",
    binaryRoot: "C:\\CompositionSmoke\\Binaries",
    evidenceRoots: [
      "D:\\CompositionSmoke\\FloorAscii",
      "D:\\CompositionSmoke\\FloorUnicode",
      "D:\\CompositionSmoke\\CurrentAscii",
      "D:\\CompositionSmoke\\CurrentUnicode",
    ],
    controllerSpoolRoot: "\\\\controller-host\\composition-smoke",
    brokerMailboxRoots: PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
      PROBE_BROKER_ROLES.map(
        (brokerRole) => `E:\\CompositionSmoke\\Broker-${environmentId}-${brokerRole}`,
      ),
    ),
    brokerJournalRoots: PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
      PROBE_BROKER_ROLES.map(
        (brokerRole) => `E:\\CompositionSmoke\\Journal-${environmentId}-${brokerRole}`,
      ),
    ),
  };
}

function memoryStore(root: string): EvidenceStore {
  return {
    root,
    createDirectory: async (path: string) => path,
    writeBytes: async (path: string, bytes: Uint8Array) => ({
      path,
      sha256: sha256(bytes),
    }),
    writeCanonicalJson: async (path: string, value: unknown) => ({
      path,
      sha256: sha256(canonicalProbeJson(value)),
    }),
    readArtifact: async () => {
      const error = new Error("not retained") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    verifyArtifactSet: async (artifacts) => artifacts,
    scan: async () => ({ files: 0, totalBytes: 0, artifacts: [] }),
    list: async () => [],
    assertRootStable: async () => undefined,
  } as EvidenceStore;
}

function syntheticBuild(fixture: BootstrapFixture): NativeBuild {
  const artifactPath = fixture.bootstrap.candidateBinaries.nativeHelperArtifactPath;
  const assemblyPath = win32.join(fixture.bootstrap.binaryRoot, ...artifactPath.split("/"));
  const candidateDirectory = win32.dirname(assemblyPath);
  return {
    assemblyPath,
    buildDirectory: candidateDirectory,
    candidateRoot: fixture.bootstrap.binaryRoot,
    candidateDirectory,
    nativeHelperArtifactPath: artifactPath,
    snapshotDirectory: win32.join(candidateDirectory, "source"),
    manifestPath: win32.join(candidateDirectory, "native-candidate.json"),
    assemblySha256: fixture.nativeManifest.assembly.sha256,
    sourceBundleSha256: fixture.nativeManifest.sourceBundleSha256,
    toolchainDigest: fixture.nativeManifest.toolchainDigest,
    candidateDigest: fixture.nativeManifest.candidateDigest,
    manifestSha256: fixture.bootstrap.nativeCandidateManifest.sha256,
    sources: fixture.nativeManifest.sources,
    toolchain: fixture.nativeManifest.toolchain,
  };
}

function authoritativeCampaignArguments(fixture: BootstrapFixture) {
  return [
    "--mode=authoritative",
    "--command=finalize",
    "--scope=campaign",
    "--campaign-run-id=campaign-run-one",
    `--plan-sha256=${PROBE_RUN_PLAN_SHA256}`,
    `--bootstrap-root=${fixture.root}`,
    `--bootstrap-sha256=${fixture.expectedSha256}`,
  ];
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows host unmocked production composition", () => {
  it("composes the real lane, controller, and runtime constructor signatures without native I/O", async () => {
    const root = await mkdtemp(join(tmpdir(), "enduragent-unmocked-composition-"));
    cleanupRoots.push(root);
    const fixture = await createBootstrapFixture(
      root,
      syntheticLayout(),
      syntheticNativeManifest(),
    );
    const loaded = await loadProbeBootstrap({
      root: fixture.root,
      expectedSha256: fixture.expectedSha256,
    });
    const localEvidenceRoot = join(root, "portable-evidence-store");
    await mkdir(localEvidenceRoot);
    const realStore = await openEvidenceStore({ root: localEvidenceRoot });
    await realStore.assertRootStable();

    const stores = new Map(
      loaded.bootstrap.evidenceRoots.map((binding) => [binding.root, memoryStore(binding.root)]),
    );
    const resolveStore = async ({
      environmentId,
      pathProfileId,
    }: {
      readonly campaignRunId: string;
      readonly environmentId: string;
      readonly pathProfileId: string;
    }) => {
      const binding = loaded.bootstrap.evidenceRoots.find(
        (entry) => entry.environmentId === environmentId && entry.pathProfileId === pathProfileId,
      );
      if (binding === undefined) throw new Error("unknown synthetic store");
      return stores.get(binding.root) as EvidenceStore;
    };
    const build = syntheticBuild(fixture);
    const metadata = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-production-composition-metadata" as const,
      clockAuthority: "attested-standard-user-system-clock" as const,
      networkTimeClaim: "none" as const,
      constructedAt: "2026-08-07T01:02:03.004Z",
      constructionMonotonic: 1234.5,
      nativeCandidateDirectory: build.candidateDirectory,
      evidenceRootCount: 4 as const,
    };
    const context: ProbeProductionLaneContext = {
      loadedBootstrap: loaded,
      nativeBuild: build,
      resolveStore,
      metadata,
    };
    const nativeLane = createProbeNativeLane(context, { rowDrivers: PROBE_NATIVE_ROW_DRIVERS });
    const controllerLane = await createProbeControllerSpoolTransport({
      loadedBootstrap: loaded,
      resolveStore,
      openSpoolStore: async ({ root: spoolRoot }) => memoryStore(spoolRoot),
      createSpoolClient: () =>
        ({
          exchange: async () => {
            throw new Error("unmocked constructor smoke must not exchange controller traffic");
          },
        }) as ControllerSpoolClient,
    });
    const runtime = createProbeAuthoritativeRuntime({
      campaignRunId: loaded.bootstrap.campaignRunId,
      candidate: loaded.candidate,
      attestations: loaded.attestations,
      runAuthorization: loaded.runAuthorization,
      brokerEnrollments: loaded.bootstrap.brokerEnrollments,
      repositoryRoot: loaded.bootstrap.repositoryRoot,
      binaryRoot: loaded.bootstrap.binaryRoot,
      lifecyclePolicy: loaded.lifecyclePolicy,
      resolveStore,
      resolvePreflightRequest: nativeLane.resolvePreflightRequest,
      nativeTransport: nativeLane.transport,
      brokerTransport: {
        observeBrokerMailbox: async () => {
          throw new Error("constructor smoke must not observe a role-local broker mailbox");
        },
      },
      controllerTransport: controllerLane,
      now: () => new Date("2026-08-07T01:02:03.004Z"),
      monotonicNow: () => 1234.5,
    });

    expect(Object.keys(nativeLane.transport)).toEqual([
      "observeGuest",
      "invokeScenarioAction",
      "readNativeTranscript",
    ]);
    expect(Object.keys(controllerLane)).toEqual([
      "observeController",
      "verifyRunAuthorization",
      "recoverOrAcquireEvidenceQuiescence",
      "renewEvidenceQuiescence",
      "captureQuiescedEvidenceSeal",
      "completeEvidenceQuiescence",
      "abandonEvidenceQuiescence",
      "invokeScenarioAction",
      "verifyScenarioActionReceipt",
      "observeCaptureDisposition",
      "signSourceTranscriptReceipt",
      "claimHardCutRequest",
      "readHardCutReceipt",
      "verifyHardCutReceipt",
    ]);
    expect(Object.keys(runtime)).toEqual([
      "schemaVersion",
      "kind",
      "authority",
      "scenarioTransportMode",
      "scenarioRetryContract",
      "operationMappingStatus",
      "disruptiveActionBoundary",
      "finalizerAdapterMode",
      "prepare",
      "segment",
      "checkpoint",
      "resume",
      "finalizeSegment",
      "finalizeCampaign",
    ]);
    expect(createAuthoritativeProbeComposition).toEqual(expect.any(Function));
    await expect(
      loadNativeHelper({ candidateRoot: "relative", candidateDirectory: "relative" }),
    ).rejects.toMatchObject({ code: "NATIVE_CANDIDATE_PATH" });
  });

  it.skipIf(process.platform === "win32")(
    "routes the default CLI through the real composition and bootstrap before the Windows boundary",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "enduragent-unmocked-cli-"));
      cleanupRoots.push(root);
      const fixture = await createBootstrapFixture(
        root,
        syntheticLayout(),
        syntheticNativeManifest(),
      );

      await expect(
        dispatchWindowsHostFalsifierCommand(authoritativeCampaignArguments(fixture)),
      ).rejects.toMatchObject({ code: "NATIVE_RUN_ROOT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "fails the default Windows graph closed until a role-local broker lane is orchestrated",
    async () => {
      const temporary = await realpath(
        await mkdtemp(join(tmpdir(), "enduragent-unmocked-windows-composition-")),
      );
      cleanupRoots.push(temporary);
      const bootstrapRoot = join(temporary, "bootstrap");
      const binaryRoot = join(temporary, "binary-root");
      const repositoryRoot = join(temporary, "repository-root");
      const controllerSpoolRoot = join(temporary, "controller-spool");
      const evidenceRoots = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
        PROBE_PATH_PROFILE_IDS.map((pathProfileId) =>
          join(temporary, `evidence-${environmentId}-${pathProfileId}`),
        ),
      );
      const brokerMailboxRoots = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
        PROBE_BROKER_ROLES.map((brokerRole) =>
          join(temporary, `broker-${environmentId}-${brokerRole}`),
        ),
      );
      const brokerJournalRoots = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
        PROBE_BROKER_ROLES.map((brokerRole) =>
          join(temporary, `journal-${environmentId}-${brokerRole}`),
        ),
      );
      await Promise.all([
        mkdir(bootstrapRoot),
        mkdir(binaryRoot),
        mkdir(repositoryRoot),
        mkdir(controllerSpoolRoot),
        ...evidenceRoots.map((root) => mkdir(root)),
        ...brokerMailboxRoots.map((root) => mkdir(root)),
        ...brokerJournalRoots.map((root) => mkdir(root)),
      ]);
      const build = await buildNativeHelper({ runRoot: binaryRoot, timeoutMs: 90_000 });
      const nativeManifest = JSON.parse(
        await readFile(build.manifestPath, "utf8"),
      ) as ProbeNativeCandidateManifest;
      const layout: BootstrapLayout = {
        repositoryRoot: await realpath(repositoryRoot),
        binaryRoot: build.candidateRoot,
        evidenceRoots: await Promise.all(evidenceRoots.map((root) => realpath(root))),
        controllerSpoolRoot: await realpath(controllerSpoolRoot),
        brokerMailboxRoots: await Promise.all(brokerMailboxRoots.map((root) => realpath(root))),
        brokerJournalRoots: await Promise.all(brokerJournalRoots.map((root) => realpath(root))),
      };
      await Promise.all([
        mkdir(join(layout.controllerSpoolRoot, "guest-to-controller")),
        mkdir(join(layout.controllerSpoolRoot, "controller-to-guest")),
      ]);
      const fixture = await createBootstrapFixture(
        bootstrapRoot,
        layout,
        nativeManifest,
        build.nativeHelperArtifactPath,
      );
      expect(fixture.bootstrap.nativeCandidateManifest.sha256).toBe(build.manifestSha256);
      expect(fixture.candidate.compiler).toMatchObject({
        codeDomProviderAssemblyVersion: nativeManifest.toolchain.codeDomProviderAssemblyVersion,
        cscFileVersion: nativeManifest.toolchain.cscFileVersion,
        cscSha256: nativeManifest.toolchain.cscSha256Before,
      });
      expect(fixture.candidate.toolchain).toMatchObject({
        powerShellVersion: nativeManifest.toolchain.powerShellVersion,
        powerShellExecutableSha256: nativeManifest.toolchain.powerShellExecutableSha256Before,
        clrVersion: nativeManifest.toolchain.clrVersion,
        runtimeDirectorySha256Before: nativeManifest.toolchain.runtimeDirectorySha256Before,
        runtimeDirectorySha256After: nativeManifest.toolchain.runtimeDirectorySha256After,
      });

      await expect(
        dispatchWindowsHostFalsifierCommand(authoritativeCampaignArguments(fixture)),
      ).rejects.toMatchObject({
        code: "COMPOSITION_BROKER_LANE_UNAVAILABLE",
        message: expect.stringContaining("primary-user, second-user, and remote-peer"),
      });
    },
    180_000,
  );
});
