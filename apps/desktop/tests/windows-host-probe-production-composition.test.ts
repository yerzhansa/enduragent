import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeCapture = vi.hoisted(() => ({ configurations: [] as unknown[] }));
const controllerSpoolCapture = vi.hoisted(() => ({
  calls: [] as unknown[],
  transport: {
    observeController: vi.fn(),
    verifyRunAuthorization: vi.fn(),
    recoverOrAcquireEvidenceQuiescence: vi.fn(),
    renewEvidenceQuiescence: vi.fn(),
    captureQuiescedEvidenceSeal: vi.fn(),
    completeEvidenceQuiescence: vi.fn(),
    abandonEvidenceQuiescence: vi.fn(),
    invokeScenarioAction: vi.fn(),
    verifyScenarioActionReceipt: vi.fn(),
    observeCaptureDisposition: vi.fn(),
    signSourceTranscriptReceipt: vi.fn(),
    claimHardCutRequest: vi.fn(),
    readHardCutReceipt: vi.fn(),
    verifyHardCutReceipt: vi.fn(),
  },
}));
const bundledNativeLaneCapture = vi.hoisted(() => ({
  calls: [] as Array<{ context: unknown; options: unknown }>,
  lane: {
    transport: {
      observeGuest: vi.fn(),
      invokeScenarioAction: vi.fn(),
      readNativeTranscript: vi.fn(),
    },
    resolvePreflightRequest: vi.fn(),
  },
}));
const defaultCompositionCapture = vi.hoisted(() => ({
  loaded: null as unknown,
  build: null as unknown,
  stores: new Map<string, unknown>(),
  bootstrapCalls: [] as unknown[],
  buildCalls: [] as unknown[],
  storeCalls: [] as unknown[],
}));

vi.mock("../scripts/windows-host-falsifier/probe-bootstrap.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scripts/windows-host-falsifier/probe-bootstrap.mjs")>();
  return {
    ...actual,
    loadProbeBootstrap: vi.fn(async (options: unknown) => {
      defaultCompositionCapture.bootstrapCalls.push(options);
      if (defaultCompositionCapture.loaded === null) throw new Error("default bootstrap unset");
      return defaultCompositionCapture.loaded;
    }),
  };
});

vi.mock("../scripts/windows-host-falsifier/native-client.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scripts/windows-host-falsifier/native-client.mjs")>();
  return {
    ...actual,
    loadNativeHelper: vi.fn(async (options: unknown) => {
      defaultCompositionCapture.buildCalls.push(options);
      if (defaultCompositionCapture.build === null) throw new Error("default build unset");
      return defaultCompositionCapture.build;
    }),
  };
});

vi.mock("../scripts/windows-host-falsifier/evidence-store.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scripts/windows-host-falsifier/evidence-store.mjs")>();
  return {
    ...actual,
    openEvidenceStore: vi.fn(async (options: { readonly root: string }) => {
      defaultCompositionCapture.storeCalls.push(options);
      const retained = defaultCompositionCapture.stores.get(options.root);
      if (retained === undefined) throw new Error("default store unset");
      return retained;
    }),
  };
});

vi.mock(
  "../scripts/windows-host-falsifier/probe-authoritative-runtime.mjs",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../scripts/windows-host-falsifier/probe-authoritative-runtime.mjs")
      >();
    return {
      ...actual,
      createProbeAuthoritativeRuntime: (
        configuration: Parameters<typeof actual.createProbeAuthoritativeRuntime>[0],
      ) => {
        runtimeCapture.configurations.push(configuration);
        return actual.createProbeAuthoritativeRuntime(configuration);
      },
    };
  },
);

vi.mock(
  "../scripts/windows-host-falsifier/probe-controller-spool-transport.mjs",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../scripts/windows-host-falsifier/probe-controller-spool-transport.mjs")
      >();
    return {
      ...actual,
      createProbeControllerSpoolTransport: vi.fn(async (options: unknown) => {
        controllerSpoolCapture.calls.push(options);
        return controllerSpoolCapture.transport;
      }),
    };
  },
);

vi.mock("../scripts/windows-host-falsifier/probe-native-lane.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../scripts/windows-host-falsifier/probe-native-lane.mjs")
    >();
  return {
    ...actual,
    createProbeNativeLane: vi.fn((context: unknown, options: unknown) => {
      bundledNativeLaneCapture.calls.push({ context, options });
      return bundledNativeLaneCapture.lane;
    }),
  };
});

import type { EvidenceStore } from "../scripts/windows-host-falsifier/evidence-store.mjs";
import { createProbeBrokerEnrollment } from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { PROBE_BROKER_ROLES } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import type { NativeBuild } from "../scripts/windows-host-falsifier/native-client.mjs";
import type {
  ProbeAuthoritativeRuntimeConfig,
  ProbeRuntimeBrokerTransport,
  ProbeRuntimeControllerTransport,
  ProbeRuntimeNativeTransport,
} from "../scripts/windows-host-falsifier/probe-authoritative-runtime.mjs";
import type {
  LoadedProbeBootstrap,
  ProbeBootstrapDocument,
  ProbeNativeCandidateManifest,
} from "../scripts/windows-host-falsifier/probe-bootstrap.mjs";
import {
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  deriveCandidateDigest,
  deriveLabAttestationDigest,
  type ProbeCandidateDigestFields,
  type ProbeCandidateIdentity,
  type ProbeLabAttestation,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type { ProbeLifecyclePolicy } from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import { PROBE_NATIVE_ROW_DRIVERS } from "../scripts/windows-host-falsifier/probe-native-row-drivers.mjs";
import {
  PROBE_PRODUCTION_CLOCK_AUTHORITY,
  ProbeProductionCompositionError,
  createAuthoritativeProbeComposition,
  type ProbeProductionCompositionFactories,
  type ProbeProductionLaneContext,
} from "../scripts/windows-host-falsifier/probe-production-composition.mjs";
import {
  deriveProbeRunAuthorizationDigest,
  type ProbeRunAuthorization,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "../scripts/windows-host-falsifier/probe-runner.mjs";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const bootstrapSha256 = sha256("bootstrap");
const assemblySha256 = sha256("native-assembly");
const manifestSha256 = sha256("native-manifest");
const nativeCandidateDigest = sha256("native-candidate");
const sourceBundleSha256 = sha256("native-source-bundle");
const toolchainDigest = sha256("native-toolchain");
const controllerIdentitySha256 = sha256("controller-identity");
const controllerPublicKeySha256 = sha256("controller-public-key");

function brokerEnrollments() {
  return PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
    PROBE_BROKER_ROLES.map((brokerRole) =>
      createProbeBrokerEnrollment({
        environmentId,
        brokerRole,
        brokerInstanceId: `${environmentId}-${brokerRole}-broker`,
        mailboxRoot: `E:\\Broker\\${environmentId}\\${brokerRole}`,
        mailboxAclSha256: sha256(`${environmentId}:${brokerRole}:mailbox-acl`),
        journalRoot: `E:\\BrokerJournal\\${environmentId}\\${brokerRole}`,
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
  );
}

function candidate(): ProbeCandidateIdentity {
  const fields: ProbeCandidateDigestFields = {
    schemaVersion: 1,
    kind: "windows-host-probe-candidate",
    repositoryCommit: "c".repeat(40),
    sourceHashes: [
      { path: "probe/native-helper.cs", sha256: sha256("native-source") },
      { path: "probe/runner.mjs", sha256: sha256("runner-source") },
    ],
    binaryHashes: [
      { path: "bin/nsis.exe", sha256: sha256("nsis") },
      { path: "bin/windows-host-falsifier-native.exe", sha256: assemblySha256 },
    ],
    compiler: {
      provider: "Microsoft.CSharp.CSharpCodeProvider",
      codeDomProviderAssemblyVersion: "4.0.0.0",
      cscFileVersion: "4.8.9256.0",
      cscSha256: sha256("csc"),
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
      powerShellExecutableSha256: sha256("powershell"),
      clrVersion: "v4.0.30319",
      runtimeDirectorySha256Before: sha256("runtime"),
      runtimeDirectorySha256After: sha256("runtime"),
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
      patchLevel: "synthetic-composition-fixture",
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
      nodeVersion: "24.5.0",
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
        Buffer.from(left.environmentId).compare(Buffer.from(right.environmentId)),
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

function nativeManifest(): ProbeNativeCandidateManifest {
  return {
    schemaVersion: 1,
    candidateDigest: nativeCandidateDigest,
    assembly: { name: "windows-host-falsifier-native.exe", sha256: assemblySha256 },
    sourceBundleSha256,
    toolchainDigest,
    sources: [{ name: "Program.cs", sha256: sha256("Program.cs"), bytes: 1024 }],
    toolchain: { assemblySha256 },
  };
}

function loadedBootstrap(): LoadedProbeBootstrap {
  const identity = candidate();
  const attestations = PROBE_ENVIRONMENT_IDS.map((environmentId) => attestation(environmentId));
  const bootstrap: ProbeBootstrapDocument = {
    schemaVersion: 1,
    kind: "windows-host-probe-bootstrap",
    campaignId: "f01-f10-native-probe-v1",
    campaignRunId: "campaign-run-one",
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidate: { path: "inventory/candidate.json", sha256: sha256("candidate") },
    attestations: [
      {
        environmentId: "win11-floor",
        artifact: { path: "inventory/floor.json", sha256: sha256("floor") },
      },
      {
        environmentId: "win11-current",
        artifact: { path: "inventory/current.json", sha256: sha256("current") },
      },
    ],
    runAuthorization: { path: "inventory/authorization.json", sha256: sha256("authorization") },
    lifecyclePolicy: { path: "inventory/lifecycle.json", sha256: sha256("lifecycle") },
    nativeCandidateManifest: {
      path: "inventory/native-candidate.json",
      sha256: manifestSha256,
    },
    candidateBinaries: {
      nativeHelperArtifactPath: "bin/windows-host-falsifier-native.exe",
      nsisArtifactPath: "bin/nsis.exe",
    },
    repositoryRoot: "C:\\Enduragent\\Repository",
    binaryRoot: "C:\\Enduragent\\Binaries",
    evidenceRoots: PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
      PROBE_PATH_PROFILE_IDS.map((pathProfileId) => ({
        environmentId,
        pathProfileId,
        root: `D:\\Evidence\\${environmentId}\\${pathProfileId}`,
      })),
    ),
    controllerSpool: {
      root: "\\\\controller-host\\enduragent-spool\\campaign-one",
      identitySha256: controllerIdentitySha256,
      publicKeySha256: controllerPublicKeySha256,
      version: "1.2.3",
    },
    brokerEnrollments: brokerEnrollments(),
  };
  return {
    bootstrapSha256,
    bootstrap,
    candidate: identity,
    attestations,
    runAuthorization: authorization(identity, attestations),
    lifecyclePolicy: lifecyclePolicy(),
    nativeCandidateManifest: nativeManifest(),
    controllerPublicKeySpkiDerBase64: "c3ludGhldGljLWNvbnRyb2xsZXItcHVibGljLWtleQ==",
  };
}

function nativeBuild(overrides: Partial<NativeBuild> = {}): NativeBuild {
  return {
    assemblyPath: "C:\\Enduragent\\Binaries\\bin\\windows-host-falsifier-native.exe",
    buildDirectory: "C:\\Enduragent\\Binaries\\bin",
    candidateRoot: "C:\\Enduragent\\Binaries",
    candidateDirectory: "C:\\Enduragent\\Binaries\\bin",
    nativeHelperArtifactPath: "bin/windows-host-falsifier-native.exe",
    snapshotDirectory: "C:\\Enduragent\\Binaries\\bin\\source",
    manifestPath: "C:\\Enduragent\\Binaries\\bin\\native-candidate.json",
    assemblySha256,
    sourceBundleSha256,
    toolchainDigest,
    candidateDigest: nativeCandidateDigest,
    manifestSha256,
    sources: [{ name: "Program.cs", sha256: sha256("Program.cs"), bytes: 1024 }],
    toolchain: { assemblySha256 },
    ...overrides,
  };
}

function store(root: string): EvidenceStore {
  return {
    root,
    createDirectory: vi.fn(async (path: string) => path),
    writeBytes: vi.fn(async (path: string) => ({ path, sha256: sha256(path) })),
    writeCanonicalJson: vi.fn(async (path: string) => ({ path, sha256: sha256(path) })),
    readArtifact: vi.fn(),
    verifyArtifactSet: vi.fn(async (values) => values),
    scan: vi.fn(async () => ({ files: 0, totalBytes: 0, artifacts: [] })),
    list: vi.fn(async () => []),
    assertRootStable: vi.fn(async () => undefined),
  } as EvidenceStore;
}

function nativeTransport(overrides: Partial<ProbeRuntimeNativeTransport> = {}) {
  return {
    observeGuest: vi.fn(),
    invokeScenarioAction: vi.fn(),
    readNativeTranscript: vi.fn(),
    ...overrides,
  } as ProbeRuntimeNativeTransport;
}

function brokerTransport(overrides: Partial<ProbeRuntimeBrokerTransport> = {}) {
  return {
    observeBrokerMailbox: vi.fn(),
    ...overrides,
  } as ProbeRuntimeBrokerTransport;
}

function controllerTransport(overrides: Partial<ProbeRuntimeControllerTransport> = {}) {
  return {
    observeController: vi.fn(),
    verifyRunAuthorization: vi.fn(),
    recoverOrAcquireEvidenceQuiescence: vi.fn(),
    renewEvidenceQuiescence: vi.fn(),
    captureQuiescedEvidenceSeal: vi.fn(),
    completeEvidenceQuiescence: vi.fn(),
    abandonEvidenceQuiescence: vi.fn(),
    invokeScenarioAction: vi.fn(),
    verifyScenarioActionReceipt: vi.fn(),
    observeCaptureDisposition: vi.fn(),
    signSourceTranscriptReceipt: vi.fn(),
    claimHardCutRequest: vi.fn(),
    readHardCutReceipt: vi.fn(),
    verifyHardCutReceipt: vi.fn(),
    ...overrides,
  } as ProbeRuntimeControllerTransport;
}

interface Fixture {
  loaded: LoadedProbeBootstrap;
  build: NativeBuild;
  stores: Map<string, EvidenceStore>;
  resolvePreflightRequest: ProbeAuthoritativeRuntimeConfig["resolvePreflightRequest"];
  native: ProbeRuntimeNativeTransport;
  broker: ProbeRuntimeBrokerTransport;
  controller: ProbeRuntimeControllerTransport;
  laneContexts: ProbeProductionLaneContext[];
  factories: {
    -readonly [Key in keyof ProbeProductionCompositionFactories]: ProbeProductionCompositionFactories[Key];
  };
}

function fixture(): Fixture {
  const loaded = loadedBootstrap();
  const build = nativeBuild();
  const stores = new Map(
    loaded.bootstrap.evidenceRoots.map((binding) => [binding.root, store(binding.root)]),
  );
  const resolvePreflightRequest = vi.fn(async () => ({
    campaignRunId: loaded.bootstrap.campaignRunId,
    executionRunId: "execution-run-one",
    executionBundleId: "execution-bundle-one",
    attemptId: "attempt-one",
    environmentId: "win11-floor" as const,
    pathProfileId: "ascii" as const,
    vmSnapshotId: "snapshot-one",
    bootIdSha256: sha256("boot-one"),
    runnerSessionIdSha256: sha256("runner-session-one"),
    nativeHelperArtifactPath: loaded.bootstrap.candidateBinaries.nativeHelperArtifactPath,
    nativeCandidateDigest: sha256("lane-supplied-native-candidate"),
    nativeManifestSha256: sha256("lane-supplied-native-manifest"),
    nsisArtifactPath: loaded.bootstrap.candidateBinaries.nsisArtifactPath,
  }));
  const native = nativeTransport();
  const broker = brokerTransport();
  const controller = controllerTransport();
  const laneContexts: ProbeProductionLaneContext[] = [];
  const factories: ProbeProductionCompositionFactories = {
    loadBootstrap: vi.fn(async () => loaded),
    loadNativeHelper: vi.fn(async () => build),
    openEvidenceStore: vi.fn(async ({ root }) => stores.get(root) as EvidenceStore),
    createNativeLane: vi.fn(async (context) => {
      laneContexts.push(context);
      return { transport: native, resolvePreflightRequest };
    }),
    createBrokerLane: vi.fn(async (context) => {
      laneContexts.push(context);
      return broker;
    }),
    createControllerLane: vi.fn(async (context) => {
      laneContexts.push(context);
      return controller;
    }),
    now: vi.fn(() => new Date("2026-08-07T01:02:03.004Z")),
    monotonicNow: vi.fn(() => 1234.5),
  };
  return {
    loaded,
    build,
    stores,
    resolvePreflightRequest,
    native,
    broker,
    controller,
    laneContexts,
    factories,
  };
}

async function compose(value: Fixture) {
  return createAuthoritativeProbeComposition({
    bootstrapRoot: "C:\\Enduragent\\Bootstrap",
    bootstrapSha256,
    factories: value.factories,
  });
}

describe("Windows host production probe composition", () => {
  beforeEach(() => {
    runtimeCapture.configurations.length = 0;
    controllerSpoolCapture.calls.length = 0;
    bundledNativeLaneCapture.calls.length = 0;
    defaultCompositionCapture.loaded = null;
    defaultCompositionCapture.build = null;
    defaultCompositionCapture.stores.clear();
    defaultCompositionCapture.bootstrapCalls.length = 0;
    defaultCompositionCapture.buildCalls.length = 0;
    defaultCompositionCapture.storeCalls.length = 0;
  });

  it("installs the six exact authoritative dispatchers without a second coordinator", async () => {
    const value = fixture();
    const composition = await compose(value);

    expect(Object.keys(composition.dispatchers)).toEqual([
      "prepare",
      "segment",
      "checkpoint",
      "resume",
      "finalizeSegment",
      "finalizeCampaign",
    ]);
    for (const key of Object.keys(composition.dispatchers) as Array<
      keyof typeof composition.dispatchers
    >) {
      expect(composition.dispatchers[key]).toBe(composition.runtime[key]);
    }
    expect(runtimeCapture.configurations).toHaveLength(1);
    expect(value.factories.loadNativeHelper).toHaveBeenCalledWith({
      candidateRoot: "C:\\Enduragent\\Binaries",
      candidateDirectory: "C:\\Enduragent\\Binaries\\bin",
    });
  });

  it("injects a supplied broker lane independently from the primary native lane", async () => {
    const value = fixture();
    await compose(value);
    const configuration = runtimeCapture.configurations.at(-1) as ProbeAuthoritativeRuntimeConfig;

    expect(value.factories.createBrokerLane).toHaveBeenCalledTimes(1);
    expect(value.factories.createBrokerLane).toHaveBeenCalledWith(value.laneContexts[1]);
    expect(configuration.brokerTransport).toBe(value.broker);
    expect(configuration.brokerTransport).not.toBe(configuration.nativeTransport);
    expect(configuration.nativeTransport).not.toHaveProperty("observeBrokerMailbox");
  });

  it("rejects every native identity mismatch before stores or transports are opened", async () => {
    for (const override of [
      { manifestSha256: sha256("wrong-manifest") },
      { assemblySha256: sha256("wrong-assembly") },
      { assemblyPath: "C:\\Enduragent\\Binaries\\bin\\wrong.exe" },
      { candidateRoot: "C:\\Enduragent\\Other" },
      { candidateDirectory: "C:\\Enduragent\\Binaries\\other" },
      { nativeHelperArtifactPath: "other\\windows-host-falsifier-native.exe" },
      { snapshotDirectory: "C:\\Enduragent\\Binaries\\bin\\other-source" },
      { candidateDigest: sha256("wrong-candidate") },
      { sourceBundleSha256: sha256("wrong-source") },
      { toolchainDigest: sha256("wrong-toolchain") },
      { sources: [{ name: "Program.cs", sha256: sha256("wrong-source-file"), bytes: 1024 }] },
      { toolchain: { assemblySha256, unexpected: true } },
    ]) {
      const value = fixture();
      value.factories.loadNativeHelper = vi.fn(async () => nativeBuild(override));

      await expect(compose(value)).rejects.toMatchObject({
        code: "COMPOSITION_NATIVE_BINDING",
      });
      expect(value.factories.openEvidenceStore).not.toHaveBeenCalled();
      expect(value.factories.createNativeLane).not.toHaveBeenCalled();
      expect(value.factories.createBrokerLane).not.toHaveBeenCalled();
      expect(value.factories.createControllerLane).not.toHaveBeenCalled();
    }

    for (const invalidBuild of [
      (() => {
        const { sources: _sources, ...missingSources } = nativeBuild();
        return missingSources;
      })(),
      { ...nativeBuild(), unexpected: true },
    ]) {
      const value = fixture();
      value.factories.loadNativeHelper = vi.fn(async () => invalidBuild as never);
      await expect(compose(value)).rejects.toMatchObject({ code: "COMPOSITION_SCHEMA" });
      expect(value.factories.openEvidenceStore).not.toHaveBeenCalled();
      expect(value.factories.createNativeLane).not.toHaveBeenCalled();
      expect(value.factories.createBrokerLane).not.toHaveBeenCalled();
      expect(value.factories.createControllerLane).not.toHaveBeenCalled();
    }

    const missingNsis = fixture();
    missingNsis.factories.loadBootstrap = vi.fn(async () => ({
      ...missingNsis.loaded,
      bootstrap: {
        ...missingNsis.loaded.bootstrap,
        candidateBinaries: {
          ...missingNsis.loaded.bootstrap.candidateBinaries,
          nsisArtifactPath: "bin/not-in-candidate-inventory.exe",
        },
      },
    }));
    await expect(compose(missingNsis)).rejects.toMatchObject({
      code: "COMPOSITION_NATIVE_BINDING",
    });
    expect(missingNsis.factories.openEvidenceStore).not.toHaveBeenCalled();
  });

  it("opens the exact 2x2 roots once, caches them, and rejects unknown coordinates", async () => {
    const value = fixture();
    await compose(value);
    const context = value.laneContexts[0];
    const roots = value.loaded.bootstrap.evidenceRoots.map((entry) => entry.root);

    expect(value.factories.openEvidenceStore).toHaveBeenCalledTimes(4);
    expect(
      vi.mocked(value.factories.openEvidenceStore!).mock.calls.map(([input]) => input.root),
    ).toEqual(roots);
    const first = await context.resolveStore({
      campaignRunId: "campaign-run-one",
      environmentId: "win11-floor",
      pathProfileId: "ascii",
    });
    const second = await context.resolveStore({
      campaignRunId: "campaign-run-one",
      environmentId: "win11-floor",
      pathProfileId: "ascii",
    });
    expect(first).toBe(second);
    expect(value.factories.openEvidenceStore).toHaveBeenCalledTimes(4);
    await expect(
      context.resolveStore({
        campaignRunId: "campaign-run-one",
        environmentId: "win11-floor",
        pathProfileId: "unknown",
      }),
    ).rejects.toMatchObject({ code: "COMPOSITION_COORDINATE" });
    expect(first.assertRootStable).toHaveBeenCalledTimes(3);
  });

  it("rejects accessor, hidden, and symbolic evidence-root bindings before opening a root", async () => {
    let accessorReads = 0;
    const createMappingVariants = (value: Fixture) => {
      const original = value.loaded.bootstrap.evidenceRoots[0];
      const accessor = { ...original };
      Object.defineProperty(accessor, "root", {
        enumerable: true,
        get: () => {
          accessorReads += 1;
          return original.root;
        },
      });
      const hidden = { ...original };
      Object.defineProperty(hidden, "root", { enumerable: false, value: original.root });
      const symbolic = { ...original } as Record<PropertyKey, unknown>;
      symbolic[Symbol("unexpected-root-binding")] = true;
      return [accessor, hidden, symbolic];
    };

    for (const malformed of createMappingVariants(fixture())) {
      const value = fixture();
      value.factories.loadBootstrap = vi.fn(async () => ({
        ...value.loaded,
        bootstrap: {
          ...value.loaded.bootstrap,
          evidenceRoots: [malformed, ...value.loaded.bootstrap.evidenceRoots.slice(1)],
        },
      })) as never;
      await expect(compose(value)).rejects.toMatchObject({ code: "COMPOSITION_SCHEMA" });
      expect(value.factories.loadNativeHelper).not.toHaveBeenCalled();
      expect(value.factories.openEvidenceStore).not.toHaveBeenCalled();
    }
    expect(accessorReads).toBe(0);
  });

  it("rejects an incomplete evidence-store factory before constructing either lane", async () => {
    const value = fixture();
    value.factories.openEvidenceStore = vi.fn(async ({ root }) => ({
      root,
      assertRootStable: vi.fn(async () => undefined),
    })) as never;

    await expect(compose(value)).rejects.toMatchObject({ code: "COMPOSITION_EVIDENCE_STORE" });
    expect(value.factories.createNativeLane).not.toHaveBeenCalled();
    expect(value.factories.createBrokerLane).not.toHaveBeenCalled();
    expect(value.factories.createControllerLane).not.toHaveBeenCalled();
  });

  it("fails closed when the default graph has no honest role-local broker lane", async () => {
    const bundled = fixture();
    defaultCompositionCapture.loaded = bundled.loaded;
    defaultCompositionCapture.build = bundled.build;
    for (const [root, retainedStore] of bundled.stores) {
      defaultCompositionCapture.stores.set(root, retainedStore);
    }

    await expect(
      createAuthoritativeProbeComposition({
        bootstrapRoot: "C:\\Enduragent\\Bootstrap",
        bootstrapSha256,
      }),
    ).rejects.toMatchObject({
      code: "COMPOSITION_BROKER_LANE_UNAVAILABLE",
      message: expect.stringContaining("primary-user, second-user, and remote-peer"),
    });

    expect(defaultCompositionCapture.bootstrapCalls).toEqual([
      {
        root: "C:\\Enduragent\\Bootstrap",
        expectedSha256: bootstrapSha256,
      },
    ]);
    expect(defaultCompositionCapture.buildCalls).toEqual([
      {
        candidateRoot: "C:\\Enduragent\\Binaries",
        candidateDirectory: "C:\\Enduragent\\Binaries\\bin",
      },
    ]);
    expect(defaultCompositionCapture.storeCalls).toEqual(
      bundled.loaded.bootstrap.evidenceRoots.map(({ root }) => ({ root })),
    );
    expect(bundledNativeLaneCapture.calls).toHaveLength(1);
    const bundledNativeLaneCall = bundledNativeLaneCapture.calls[0];
    if (bundledNativeLaneCall === undefined) throw new Error("bundled native lane was not called");
    expect(bundledNativeLaneCall.options).toEqual({
      rowDrivers: PROBE_NATIVE_ROW_DRIVERS,
    });
    expect(controllerSpoolCapture.calls).toHaveLength(0);
    expect(runtimeCapture.configurations).toHaveLength(0);
  });

  it("rejects incomplete factory bundles instead of constructing a hybrid graph", async () => {
    const value = fixture();
    const { createBrokerLane: _omittedBrokerLane, ...incompleteFactories } = value.factories;

    await expect(
      createAuthoritativeProbeComposition({
        bootstrapRoot: "C:\\Enduragent\\Bootstrap",
        bootstrapSha256,
        factories: incompleteFactories as never,
      }),
    ).rejects.toMatchObject({ code: "COMPOSITION_SCHEMA" });
    expect(value.factories.loadBootstrap).not.toHaveBeenCalled();
    expect(bundledNativeLaneCapture.calls).toHaveLength(0);
    expect(controllerSpoolCapture.calls).toHaveLength(0);
  });

  it("rejects malformed lane surfaces", async () => {
    const malformedNative = fixture();

    malformedNative.factories.createNativeLane = vi.fn(async () => ({
      transport: {},
      resolvePreflightRequest: malformedNative.resolvePreflightRequest,
    })) as unknown as ProbeProductionCompositionFactories["createNativeLane"];
    await expect(compose(malformedNative)).rejects.toMatchObject({ code: "RUNTIME_SCHEMA" });

    const malformedBroker = fixture();
    malformedBroker.factories.createBrokerLane = vi.fn(
      async () => ({}) as ProbeRuntimeBrokerTransport,
    );
    await expect(compose(malformedBroker)).rejects.toMatchObject({ code: "COMPOSITION_SCHEMA" });

    const malformedController = fixture();
    malformedController.factories.createControllerLane = vi.fn(
      async () => ({ observeController: vi.fn() }) as unknown as ProbeRuntimeControllerTransport,
    );
    await expect(compose(malformedController)).rejects.toMatchObject({ code: "RUNTIME_SCHEMA" });
  });

  it("rejects a broker observer cross-wired to the primary native lane", async () => {
    const value = fixture();
    value.factories.createBrokerLane = vi.fn(async () => ({
      observeBrokerMailbox: value.native.observeGuest,
    }));

    await expect(compose(value)).rejects.toMatchObject({
      code: "COMPOSITION_BROKER_LANE_CROSS_WIRED",
    });
    expect(value.factories.createControllerLane).not.toHaveBeenCalled();
    expect(runtimeCapture.configurations).toHaveLength(0);
  });

  it("rejects accessor, hidden, symbolic, and inherited factory surfaces", async () => {
    const value = fixture();
    const malformedBundles: unknown[] = [];

    const accessor = { ...value.factories };
    Object.defineProperty(accessor, "now", {
      enumerable: true,
      configurable: true,
      get: () => value.factories.now,
    });
    malformedBundles.push(accessor);

    const hidden = { ...value.factories };
    Object.defineProperty(hidden, "now", {
      enumerable: false,
      configurable: true,
      value: value.factories.now,
    });
    malformedBundles.push(hidden);

    const symbolic = { ...value.factories } as Record<PropertyKey, unknown>;
    symbolic[Symbol("unexpected-factory")] = vi.fn();
    malformedBundles.push(symbolic);

    const inherited = Object.assign(Object.create({ unexpectedFactory: vi.fn() }), value.factories);
    malformedBundles.push(inherited);

    for (const factories of malformedBundles) {
      await expect(
        createAuthoritativeProbeComposition({
          bootstrapRoot: "C:\\Enduragent\\Bootstrap",
          bootstrapSha256,
          factories: factories as never,
        }),
      ).rejects.toMatchObject({
        name: "ProbeProductionCompositionError",
        code: "COMPOSITION_SCHEMA",
      });
    }
    expect(value.factories.loadBootstrap).not.toHaveBeenCalled();
  });

  it("binds loaded native build identity into every lane-resolved preflight request", async () => {
    const value = fixture();
    await compose(value);
    const configuration = runtimeCapture.configurations.at(-1) as ProbeAuthoritativeRuntimeConfig;

    expect(configuration.resolvePreflightRequest).not.toBe(value.resolvePreflightRequest);
    const input = {
      command: {},
      candidate: value.loaded.candidate,
      attestation: value.loaded.attestations[0],
      evidenceRoot: "D:\\Evidence\\win11-floor\\ascii",
    } as Parameters<ProbeAuthoritativeRuntimeConfig["resolvePreflightRequest"]>[0];
    const request = await configuration.resolvePreflightRequest(input);
    expect(value.resolvePreflightRequest).toHaveBeenCalledWith(input);
    expect(request.nativeCandidateDigest).toBe(value.build.candidateDigest);
    expect(request.nativeManifestSha256).toBe(value.build.manifestSha256);
    expect(request.nativeCandidateDigest).not.toBe(sha256("lane-supplied-native-candidate"));
    expect(request.nativeManifestSha256).not.toBe(sha256("lane-supplied-native-manifest"));
    expect(Object.isFrozen(request)).toBe(true);
    expect(configuration.nativeTransport).toBe(value.native);
    expect(configuration.brokerTransport).toBe(value.broker);
    expect(configuration.controllerTransport).toBe(value.controller);
  });

  it("has no secret-bearing construction fields and rejects unexpected inputs", async () => {
    const value = fixture();
    await expect(
      createAuthoritativeProbeComposition({
        bootstrapRoot: "C:\\Enduragent\\Bootstrap",
        bootstrapSha256,
        factories: null,
      } as never),
    ).rejects.toMatchObject({ code: "COMPOSITION_SCHEMA" });
    await expect(
      createAuthoritativeProbeComposition({
        bootstrapRoot: "C:\\Enduragent\\Bootstrap",
        bootstrapSha256,
        privateKey: "forbidden",
        factories: value.factories,
      } as never),
    ).rejects.toMatchObject({ code: "COMPOSITION_SCHEMA" });
    await expect(
      createAuthoritativeProbeComposition({
        bootstrapRoot: "C:\\Enduragent\\Bootstrap",
        bootstrapSha256,
        factories: { ...value.factories, unknownControllerFactory: vi.fn() },
      } as never),
    ).rejects.toMatchObject({ code: "COMPOSITION_SCHEMA" });
    await compose(value);
    for (const context of value.laneContexts) {
      expect(context).not.toHaveProperty("privateKey");
      expect(context).not.toHaveProperty("secret");
      expect(context).not.toHaveProperty("credentials");
    }
  });

  it("binds finite local clocks and deep-freezes the composition metadata", async () => {
    const value = fixture();
    const composition = await compose(value);

    expect(composition.metadata).toMatchObject({
      clockAuthority: PROBE_PRODUCTION_CLOCK_AUTHORITY,
      networkTimeClaim: "none",
      constructedAt: "2026-08-07T01:02:03.004Z",
      constructionMonotonic: 1234.5,
      evidenceRootCount: 4,
    });
    expect(Number.isFinite(composition.metadata.constructionMonotonic)).toBe(true);
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.metadata)).toBe(true);
    expect(Object.isFrozen(composition.loadedBootstrap.bootstrap.evidenceRoots[0])).toBe(true);
    expect(Object.isFrozen(composition.nativeBuild.toolchain)).toBe(true);

    const invalidWall = fixture();
    invalidWall.factories.now = () => new Date(Number.NaN);
    await expect(compose(invalidWall)).rejects.toMatchObject({ code: "COMPOSITION_CLOCK" });
    const invalidMonotonic = fixture();
    invalidMonotonic.factories.monotonicNow = () => Number.POSITIVE_INFINITY;
    await expect(compose(invalidMonotonic)).rejects.toMatchObject({
      code: "COMPOSITION_CLOCK",
    });
  });

  it("does not accept a caller-supplied loaded bootstrap in place of root plus digest", async () => {
    const value = fixture();
    await expect(
      createAuthoritativeProbeComposition({
        loadedBootstrap: value.loaded,
        factories: value.factories,
      } as never),
    ).rejects.toBeInstanceOf(ProbeProductionCompositionError);
    expect(value.factories.loadBootstrap).not.toHaveBeenCalled();
  });
});
