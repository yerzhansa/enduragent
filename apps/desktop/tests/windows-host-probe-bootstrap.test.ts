import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProbeBrokerEnrollment } from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import { PROBE_BROKER_ROLES } from "../scripts/windows-host-falsifier/broker/protocol.mjs";
import {
  PROBE_BOOTSTRAP_MAXIMUM_BYTES,
  ProbeBootstrapError,
  loadProbeBootstrap,
  type ProbeBootstrapDocument,
  type ProbeNativeCandidateManifest,
} from "../scripts/windows-host-falsifier/probe-bootstrap.mjs";
import { deriveNativeManifestDigests } from "../scripts/windows-host-falsifier/native-manifest-digest.mjs";
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
import type { ProbeLifecyclePolicy } from "../scripts/windows-host-falsifier/probe-preflight.mjs";
import {
  deriveProbeRunAuthorizationDigest,
  type ProbeRunAuthorization,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "../scripts/windows-host-falsifier/probe-runner.mjs";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const nativeAssemblySha256 = sha256("native-assembly");
const controllerIdentitySha256 = sha256("controller-identity");
const controllerKeyPair = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeyPair.publicKey.export({
  format: "der",
  type: "spki",
});
const controllerPublicKeySha256 = sha256(controllerPublicKeyBytes);

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
      { path: "bin/windows-host-falsifier-native.exe", sha256: nativeAssemblySha256 },
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
      patchLevel: "synthetic-bootstrap-fixture",
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
  overrides: Partial<ProbeRunAuthorization> = {},
): ProbeRunAuthorization {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: identity.candidateSha256,
    campaignRunId: "campaign-run-01",
    attestations: attestations
      .map(({ environmentId, attestationSha256 }) => ({ environmentId, attestationSha256 }))
      .sort((left, right) =>
        Buffer.from(left.environmentId).compare(Buffer.from(right.environmentId)),
      ),
    issuedAt: "2026-08-07T00:00:00.000Z",
    expiresAt: "2026-08-08T00:00:00.000Z",
    operatorKeyId: "operator-01",
    trustStoreId: "windows-lab-operators",
    trustStoreGeneration: 1,
    signatureAlgorithm: "Ed25519" as const,
    ...overrides,
  };
  const authorizationSha256 = deriveProbeRunAuthorizationDigest(unsigned);
  return {
    ...unsigned,
    authorizationSha256,
    signatureBase64: Buffer.alloc(64, 7).toString("base64"),
  } as ProbeRunAuthorization;
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
    schemaVersion: 1,
    powerShellVersion: "5.1.26100.7705",
    powerShellEdition: "Desktop",
    clrVersion: "4.8.0",
    codeDomProvider: "Microsoft.CSharp.CSharpCodeProvider",
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
    outputType: "ConsoleApplication",
    platform: "x64",
    compilerOptions: "/noconfig /nostdlib+ /platform:x64 /target:exe",
    referencedAssemblies: references.map((entry) => entry.name),
    referenceSha256Before: references,
    referenceSha256After: references,
    addTypeInvocation: "Add-Type -OutputType ConsoleApplication",
    sourceSha256Before: sourceDigests,
    sourceSha256After: sourceDigests,
    assemblySha256: nativeAssemblySha256,
  };
  return {
    schemaVersion: 1,
    ...deriveNativeManifestDigests({
      sources,
      toolchain,
      assemblySha256: nativeAssemblySha256,
    }),
    assembly: {
      name: "windows-host-falsifier-native.exe",
      sha256: nativeAssemblySha256,
    },
    sources,
    toolchain,
  };
}

interface Fixture {
  root: string;
  bootstrap: ProbeBootstrapDocument;
  expectedSha256: string;
  paths: {
    candidate: string;
    floor: string;
    current: string;
    authorization: string;
    lifecycle: string;
    native: string;
    controllerPublicKey: string;
  };
  values: {
    candidate: ProbeCandidateIdentity;
    attestations: ProbeLabAttestation[];
    authorization: ProbeRunAuthorization;
    lifecycle: ProbeLifecyclePolicy;
    native: ProbeNativeCandidateManifest;
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

async function createFixture(root: string): Promise<Fixture> {
  const identity = candidate();
  const attestations = PROBE_ENVIRONMENT_IDS.map((environmentId) => attestation(environmentId));
  const runAuthorization = authorization(identity, attestations);
  const lifecycle = lifecyclePolicy();
  const native = nativeManifest();
  const brokerEnrollments = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) => {
    const environmentAttestation = attestations.find(
      (entry) => entry.environmentId === environmentId,
    )!;
    return PROBE_BROKER_ROLES.map((brokerRole) =>
      createProbeBrokerEnrollment({
        environmentId,
        brokerRole,
        brokerInstanceId: `${environmentId}-${brokerRole}-broker`,
        mailboxRoot: `E:\\Broker\\${environmentId}\\${brokerRole}`,
        mailboxAclSha256: sha256(`${environmentId}-${brokerRole}-mailbox-acl`),
        journalRoot: `E:\\BrokerJournal\\${environmentId}\\${brokerRole}`,
        journalRootAclSha256: sha256(`${environmentId}-${brokerRole}-journal-root-acl`),
        journalDatabaseAclSha256: sha256(`${environmentId}-${brokerRole}-journal-database-acl`),
        processSidSha256:
          brokerRole === "primary-standard-user"
            ? environmentAttestation.host.standardUserSidSha256
            : sha256(`${environmentId}-${brokerRole}-process-sid`),
        peerAuthoritySha256:
          brokerRole === "remote-peer" ? sha256(`${environmentId}-remote-peer-authority`) : null,
      }),
    );
  });
  const paths = {
    candidate: "inventory/candidate.json",
    floor: "inventory/attestation-floor.json",
    current: "inventory/attestation-current.json",
    authorization: "inventory/run-authorization.json",
    lifecycle: "inventory/lifecycle-policy.json",
    native: "inventory/native-candidate.json",
    controllerPublicKey: "attestations/controller-public-key.spki.der",
  };
  const candidateReference = await writeCanonical(root, paths.candidate, identity);
  const floorReference = await writeCanonical(root, paths.floor, attestations[0]);
  const currentReference = await writeCanonical(root, paths.current, attestations[1]);
  const authorizationReference = await writeCanonical(root, paths.authorization, runAuthorization);
  const lifecycleReference = await writeCanonical(root, paths.lifecycle, lifecycle);
  const nativeReference = await writeCanonical(root, paths.native, native);
  await writeBytes(root, paths.controllerPublicKey, controllerPublicKeyBytes);
  const bootstrap: ProbeBootstrapDocument = {
    schemaVersion: 1,
    kind: "windows-host-probe-bootstrap",
    campaignId: "f01-f10-native-probe-v1",
    campaignRunId: "campaign-run-01",
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
    brokerEnrollments,
  };
  const bootstrapBytes = canonicalProbeJson(bootstrap);
  await writeBytes(root, "bootstrap.json", bootstrapBytes);
  return {
    root,
    bootstrap,
    expectedSha256: sha256(bootstrapBytes),
    paths,
    values: {
      candidate: identity,
      attestations,
      authorization: runAuthorization,
      lifecycle,
      native,
    },
  };
}

async function rewriteBootstrap(fixture: Fixture, value: unknown) {
  const bytes = canonicalProbeJson(value);
  await writeBytes(fixture.root, "bootstrap.json", bytes);
  return sha256(bytes);
}

async function replaceReference(
  fixture: Fixture,
  key: "authorization" | "lifecycle" | "native",
  value: unknown,
) {
  const reference = await writeCanonical(fixture.root, fixture.paths[key], value);
  const bootstrapKey =
    key === "authorization"
      ? "runAuthorization"
      : key === "lifecycle"
        ? "lifecyclePolicy"
        : "nativeCandidateManifest";
  const bootstrap = { ...fixture.bootstrap, [bootstrapKey]: reference };
  return { bootstrap, expectedSha256: await rewriteBootstrap(fixture, bootstrap) };
}

describe("Windows host immutable probe bootstrap", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "enduragent-probe-bootstrap-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads one digest-bound, campaign-specific inventory and deep-freezes it", async () => {
    const fixture = await createFixture(root);
    const loaded = await loadProbeBootstrap({
      root,
      expectedSha256: fixture.expectedSha256,
    });

    expect(loaded.bootstrap).toEqual(fixture.bootstrap);
    expect(loaded.candidate.candidateSha256).toBe(fixture.values.candidate.candidateSha256);
    expect(loaded.attestations.map((entry) => entry.environmentId)).toEqual([
      "win11-floor",
      "win11-current",
    ]);
    expect(loaded.runAuthorization.authorizationSha256).toBe(
      fixture.values.authorization.authorizationSha256,
    );
    expect(loaded.nativeCandidateManifest).toMatchObject({
      sourceBundleSha256: "99a533e4facfe13f19d75073562231c43b88db72755927d8b7579545676a0c03",
      toolchainDigest: "1c9c071bf3c994a20960a05afbe66b6be882f555b953d09eb08f9dc4c49b6fb0",
      candidateDigest: "8ef07a993ac106b4f8308a3bbf9fcb6e50b1143323540c4adabe5b0e706a3e7d",
    });
    expect(loaded.controllerPublicKeySpkiDerBase64).toBe(
      controllerPublicKeyBytes.toString("base64"),
    );
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.bootstrap.evidenceRoots[0])).toBe(true);
    expect(Object.isFrozen(loaded.bootstrap.brokerEnrollments[0])).toBe(true);
    expect(Object.isFrozen(loaded.attestations[0].controller.publicKeyArtifact)).toBe(true);
    expect(Object.isFrozen(loaded.attestations[0].guestEvidenceByPathProfile[0].artifact)).toBe(
      true,
    );
    expect(Object.isFrozen(loaded.nativeCandidateManifest.toolchain)).toBe(true);
  });

  it("rejects an attestation whose path-profile guest evidence inventory is reordered", async () => {
    const fixture = await createFixture(root);
    const current = fixture.values.attestations[1];
    const fields = {
      ...current,
      guestEvidenceByPathProfile: [...current.guestEvidenceByPathProfile].reverse(),
    };
    const changed = {
      ...fields,
      attestationSha256: deriveLabAttestationDigest(fields),
    };
    const reference = await writeCanonical(root, fixture.paths.current, changed);
    const bootstrap = {
      ...fixture.bootstrap,
      attestations: [
        fixture.bootstrap.attestations[0],
        { environmentId: "win11-current", artifact: reference },
      ],
    };

    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, bootstrap),
      }),
    ).rejects.toMatchObject({ code: "ATTESTATION_GUEST_EVIDENCE" });
  });

  it("accepts one canonical controller-owned UNC spool without treating it as evidence", async () => {
    const fixture = await createFixture(root);
    const spoolRoot = "\\\\controller-host\\enduragent-spool\\campaign-one";
    const bootstrap = {
      ...fixture.bootstrap,
      controllerSpool: { ...fixture.bootstrap.controllerSpool, root: spoolRoot },
    };
    const expectedSha256 = await rewriteBootstrap(fixture, bootstrap);
    const loaded = await loadProbeBootstrap({ root, expectedSha256 });
    expect(loaded.bootstrap.controllerSpool.root).toBe(spoolRoot);
    expect(loaded.bootstrap.evidenceRoots.every((entry) => entry.root !== spoolRoot)).toBe(true);
  });

  it("rejects incomplete, reordered, non-ASCII, or attestation-mismatched broker enrollments", async () => {
    const fixture = await createFixture(root);
    const inventoryCases = [
      fixture.bootstrap.brokerEnrollments.slice(0, -1),
      [
        fixture.bootstrap.brokerEnrollments[1],
        fixture.bootstrap.brokerEnrollments[0],
        ...fixture.bootstrap.brokerEnrollments.slice(2),
      ],
      fixture.bootstrap.brokerEnrollments.map((entry, index) =>
        index === 0 ? { ...entry, mailboxRoot: "E:\\Broker\\Unicode-Ж" } : entry,
      ),
    ];
    for (const brokerEnrollments of inventoryCases) {
      await expect(
        loadProbeBootstrap({
          root,
          expectedSha256: await rewriteBootstrap(fixture, {
            ...fixture.bootstrap,
            brokerEnrollments,
          }),
        }),
      ).rejects.toBeDefined();
    }

    const primary = fixture.bootstrap.brokerEnrollments[0];
    const mismatchedPrimary = createProbeBrokerEnrollment({
      environmentId: primary.environmentId,
      brokerRole: primary.brokerRole,
      brokerInstanceId: primary.brokerInstanceId,
      mailboxRoot: primary.mailboxRoot,
      mailboxAclSha256: primary.mailboxAclSha256,
      journalRoot: primary.journalRoot,
      journalRootAclSha256: primary.journalRootAclSha256,
      journalDatabaseAclSha256: primary.journalDatabaseAclSha256,
      processSidSha256: sha256("another-primary-process-sid"),
      peerAuthoritySha256: null,
    });
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, {
          ...fixture.bootstrap,
          brokerEnrollments: [mismatchedPrimary, ...fixture.bootstrap.brokerEnrollments.slice(1)],
        }),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_BROKER_BINDING" });
  });

  it("rejects a broker mailbox nested beneath another bootstrap-owned root", async () => {
    const fixture = await createFixture(root);
    const first = fixture.bootstrap.brokerEnrollments[0];
    const nested = createProbeBrokerEnrollment({
      environmentId: first.environmentId,
      brokerRole: first.brokerRole,
      brokerInstanceId: first.brokerInstanceId,
      mailboxRoot: `${fixture.bootstrap.repositoryRoot}\\BrokerMailbox`,
      mailboxAclSha256: first.mailboxAclSha256,
      journalRoot: first.journalRoot,
      journalRootAclSha256: first.journalRootAclSha256,
      journalDatabaseAclSha256: first.journalDatabaseAclSha256,
      processSidSha256: first.processSidSha256,
      peerAuthoritySha256: null,
    });
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, {
          ...fixture.bootstrap,
          brokerEnrollments: [nested, ...fixture.bootstrap.brokerEnrollments.slice(1)],
        }),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_ROOT_OVERLAP" });
  });

  it("rejects a broker journal nested beneath another bootstrap-owned root", async () => {
    const fixture = await createFixture(root);
    const first = fixture.bootstrap.brokerEnrollments[0];
    const nested = createProbeBrokerEnrollment({
      environmentId: first.environmentId,
      brokerRole: first.brokerRole,
      brokerInstanceId: first.brokerInstanceId,
      mailboxRoot: first.mailboxRoot,
      mailboxAclSha256: first.mailboxAclSha256,
      journalRoot: `${fixture.bootstrap.binaryRoot}\\BrokerJournal`,
      journalRootAclSha256: first.journalRootAclSha256,
      journalDatabaseAclSha256: first.journalDatabaseAclSha256,
      processSidSha256: first.processSidSha256,
      peerAuthoritySha256: null,
    });
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, {
          ...fixture.bootstrap,
          brokerEnrollments: [nested, ...fixture.bootstrap.brokerEnrollments.slice(1)],
        }),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_ROOT_OVERLAP" });
  });

  it.each([
    "\\\\?\\UNC\\controller-host\\enduragent-spool",
    "\\\\.\\pipe\\controller-spool",
    "\\\\controller-host",
    "\\\\controller-host\\enduragent-spool\\..\\escape",
    "\\\\controller-host\\enduragent-spool:stream",
    "\\\\controller-host\\enduragent-spool\\",
  ])("rejects unsafe controller spool root %s", async (spoolRoot) => {
    const fixture = await createFixture(root);
    const bootstrap = {
      ...fixture.bootstrap,
      controllerSpool: { ...fixture.bootstrap.controllerSpool, root: spoolRoot },
    };
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, bootstrap),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_ABSOLUTE_ROOT" });
  });

  it("rejects an external bootstrap digest mismatch before trusting its contents", async () => {
    const fixture = await createFixture(root);
    await expect(
      loadProbeBootstrap({ root, expectedSha256: sha256("another-bootstrap") }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_ARTIFACT_DRIFT" });
    expect(fixture.expectedSha256).not.toBe(sha256("another-bootstrap"));
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d]), "BOOTSTRAP_UTF8"],
    [
      "a UTF-8 BOM",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}\n")]),
      "BOOTSTRAP_UTF8",
    ],
    ["noncanonical JSON", Buffer.from('{"schemaVersion":1}\n'), "BOOTSTRAP_CANONICAL"],
  ])("rejects %s in bootstrap.json", async (_label, bytes, code) => {
    await writeBytes(root, "bootstrap.json", bytes);
    await expect(loadProbeBootstrap({ root, expectedSha256: sha256(bytes) })).rejects.toMatchObject(
      { code },
    );
  });

  it("rejects unknown bootstrap keys", async () => {
    const fixture = await createFixture(root);
    const bootstrap = { ...fixture.bootstrap, extraLocator: "inventory/extra.json" };
    const expectedSha256 = await rewriteBootstrap(fixture, bootstrap);
    await expect(loadProbeBootstrap({ root, expectedSha256 })).rejects.toMatchObject({
      code: "BOOTSTRAP_SCHEMA",
    });
  });

  it.each([
    "../candidate.json",
    "C:/candidate.json",
    "//server/share/candidate.json",
    "inventory/candidate.json:stream",
    "inventory\\candidate.json",
  ])("rejects unsafe reference path %s", async (path) => {
    const fixture = await createFixture(root);
    const bootstrap = { ...fixture.bootstrap, candidate: { ...fixture.bootstrap.candidate, path } };
    const expectedSha256 = await rewriteBootstrap(fixture, bootstrap);
    await expect(loadProbeBootstrap({ root, expectedSha256 })).rejects.toBeInstanceOf(
      ProbeBootstrapError,
    );
  });

  it("rejects a case-mismatched referenced artifact", async () => {
    const fixture = await createFixture(root);
    await rename(
      join(root, "inventory", "candidate.json"),
      join(root, "inventory", "Candidate.json"),
    );
    await expect(
      loadProbeBootstrap({ root, expectedSha256: fixture.expectedSha256 }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_CASE_COLLISION" });
  });

  it("rejects a symlinked referenced artifact", async () => {
    const fixture = await createFixture(root);
    const target = join(root, "outside-candidate.json");
    await writeFile(target, canonicalProbeJson(fixture.values.candidate));
    await rm(join(root, "inventory", "candidate.json"));
    await symlink(target, join(root, "inventory", "candidate.json"));
    await expect(
      loadProbeBootstrap({ root, expectedSha256: fixture.expectedSha256 }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_REPARSE" });
  });

  it("rejects drift in a digest-bound referenced JSON artifact", async () => {
    const fixture = await createFixture(root);
    await writeBytes(root, fixture.paths.candidate, canonicalProbeJson({ changed: true }));
    await expect(
      loadProbeBootstrap({ root, expectedSha256: fixture.expectedSha256 }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_ARTIFACT_DRIFT" });
  });

  it.each(["campaign", "candidate", "attestations"])(
    "rejects run-authorization %s cross-binding drift",
    async (binding) => {
      const fixture = await createFixture(root);
      const overrides: Partial<ProbeRunAuthorization> =
        binding === "campaign"
          ? { campaignRunId: "another-campaign" }
          : binding === "candidate"
            ? { candidateSha256: sha256("another-candidate") }
            : {
                attestations: [
                  {
                    environmentId: "win11-current",
                    attestationSha256: sha256("another-attestation"),
                  },
                  {
                    environmentId: "win11-floor",
                    attestationSha256: fixture.values.attestations[0].attestationSha256,
                  },
                ],
              };
      const changed = authorization(
        fixture.values.candidate,
        fixture.values.attestations,
        overrides,
      );
      const replacement = await replaceReference(fixture, "authorization", changed);
      await expect(
        loadProbeBootstrap({ root, expectedSha256: replacement.expectedSha256 }),
      ).rejects.toMatchObject({ code: "BOOTSTRAP_AUTHORIZATION_BINDING" });
    },
  );

  it("rejects missing and duplicate evidence-root mappings", async () => {
    const fixture = await createFixture(root);
    const missing = {
      ...fixture.bootstrap,
      evidenceRoots: fixture.bootstrap.evidenceRoots.slice(0, -1),
    };
    await expect(
      loadProbeBootstrap({ root, expectedSha256: await rewriteBootstrap(fixture, missing) }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_EVIDENCE_ROOTS" });

    const duplicate = {
      ...fixture.bootstrap,
      evidenceRoots: [
        ...fixture.bootstrap.evidenceRoots.slice(0, -1),
        fixture.bootstrap.evidenceRoots[0],
      ],
    };
    await expect(
      loadProbeBootstrap({ root, expectedSha256: await rewriteBootstrap(fixture, duplicate) }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_EVIDENCE_ROOTS" });
  });

  it("rejects case-colliding root and reference mappings", async () => {
    const fixture = await createFixture(root);
    const caseCollidingRoots = fixture.bootstrap.evidenceRoots.map((entry, index) =>
      index === 1
        ? {
            ...entry,
            root: `D:\\${fixture.bootstrap.evidenceRoots[0].root
              .slice(3)
              .toLocaleLowerCase("en-US")}`,
          }
        : entry,
    );
    const rootCollision = { ...fixture.bootstrap, evidenceRoots: caseCollidingRoots };
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, rootCollision),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_CASE_COLLISION" });

    const referenceCollision = {
      ...fixture.bootstrap,
      nativeCandidateManifest: {
        ...fixture.bootstrap.nativeCandidateManifest,
        path: fixture.bootstrap.candidate.path.toLocaleUpperCase("en-US"),
      },
    };
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, referenceCollision),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_CASE_COLLISION" });
  });

  it("rejects every nested or case-aliased absolute-root pairing", async () => {
    const fixture = await createFixture(root);
    const firstEvidenceRoot = fixture.bootstrap.evidenceRoots[0].root;
    const cases: readonly ProbeBootstrapDocument[] = [
      {
        ...fixture.bootstrap,
        binaryRoot: `${fixture.bootstrap.repositoryRoot}\\Binaries`,
      },
      {
        ...fixture.bootstrap,
        repositoryRoot: "C:\\ENDURAGENT\\BINARIES\\Repository",
      },
      {
        ...fixture.bootstrap,
        evidenceRoots: fixture.bootstrap.evidenceRoots.map((entry, index) =>
          index === 0 ? { ...entry, root: `${fixture.bootstrap.repositoryRoot}\\Evidence` } : entry,
        ),
      },
      {
        ...fixture.bootstrap,
        repositoryRoot: `${firstEvidenceRoot.slice(0, 3)}${firstEvidenceRoot
          .slice(3)
          .toLocaleUpperCase("en-US")}\\Repository`,
      },
      {
        ...fixture.bootstrap,
        evidenceRoots: fixture.bootstrap.evidenceRoots.map((entry, index) =>
          index === 1
            ? {
                ...entry,
                root: `${firstEvidenceRoot.slice(0, 3)}${firstEvidenceRoot
                  .slice(3)
                  .toLocaleUpperCase("en-US")}\\Nested`,
              }
            : entry,
        ),
      },
      {
        ...fixture.bootstrap,
        controllerSpool: {
          ...fixture.bootstrap.controllerSpool,
          root: "C:\\ENDURAGENT\\BINARIES\\Spool",
        },
      },
      {
        ...fixture.bootstrap,
        controllerSpool: {
          ...fixture.bootstrap.controllerSpool,
          root: "D:\\EVIDENCE",
        },
      },
    ];

    for (const bootstrap of cases) {
      await expect(
        loadProbeBootstrap({
          root,
          expectedSha256: await rewriteBootstrap(fixture, bootstrap),
        }),
      ).rejects.toMatchObject({ code: "BOOTSTRAP_ROOT_OVERLAP" });
    }
  });

  it("compares complete Windows components within distinct drive and UNC namespaces", async () => {
    const fixture = await createFixture(root);
    const bootstrap: ProbeBootstrapDocument = {
      ...fixture.bootstrap,
      binaryRoot: "C:\\Enduragent\\Repository-Cache",
      controllerSpool: {
        ...fixture.bootstrap.controllerSpool,
        root: "\\\\C\\Enduragent\\Repository",
      },
    };

    const loaded = await loadProbeBootstrap({
      root,
      expectedSha256: await rewriteBootstrap(fixture, bootstrap),
    });
    expect(loaded.bootstrap.binaryRoot).toBe(bootstrap.binaryRoot);
    expect(loaded.bootstrap.controllerSpool.root).toBe(bootstrap.controllerSpool.root);
  });

  it.each(["source", "toolchain"] as const)(
    "rejects native manifest %s component tampering even when the artifact hash is updated",
    async (component) => {
      const fixture = await createFixture(root);
      const native =
        component === "source"
          ? {
              ...fixture.values.native,
              sources: [
                { ...fixture.values.native.sources[0], bytes: 1025 },
                ...fixture.values.native.sources.slice(1),
              ],
            }
          : {
              ...fixture.values.native,
              toolchain: {
                ...fixture.values.native.toolchain,
                cscFileVersion: "4.8.9256.1",
              },
            };
      const replacement = await replaceReference(fixture, "native", native);

      await expect(
        loadProbeBootstrap({ root, expectedSha256: replacement.expectedSha256 }),
      ).rejects.toMatchObject({ code: "BOOTSTRAP_NATIVE_MANIFEST_DIGEST" });
    },
  );

  it.each(["sourceBundleSha256", "toolchainDigest", "candidateDigest"] as const)(
    "rejects native manifest %s aggregate tampering even when the artifact hash is updated",
    async (aggregate) => {
      const fixture = await createFixture(root);
      const native = { ...fixture.values.native, [aggregate]: sha256(`tampered-${aggregate}`) };
      const replacement = await replaceReference(fixture, "native", native);

      await expect(
        loadProbeBootstrap({ root, expectedSha256: replacement.expectedSha256 }),
      ).rejects.toMatchObject({ code: "BOOTSTRAP_NATIVE_MANIFEST_DIGEST" });
    },
  );

  it("rejects secret-shaped fields recursively in referenced JSON", async () => {
    const fixture = await createFixture(root);
    const lifecycleWithCredential = {
      ...fixture.values.lifecycle,
      mappings: [
        { ...fixture.values.lifecycle.mappings[0], credential: "must-not-load" },
        fixture.values.lifecycle.mappings[1],
      ],
    };
    const replacement = await replaceReference(fixture, "lifecycle", lifecycleWithCredential);
    await expect(
      loadProbeBootstrap({ root, expectedSha256: replacement.expectedSha256 }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_SECRET" });
  });

  it("rejects divergent controller identity metadata between attestations", async () => {
    const fixture = await createFixture(root);
    const fields = {
      ...fixture.values.attestations[1],
      controller: {
        ...fixture.values.attestations[1].controller,
        identitySha256: sha256("another-controller"),
      },
    };
    const changedAttestation = {
      ...fields,
      attestationSha256: deriveLabAttestationDigest(fields),
    } as ProbeLabAttestation;
    const reference = await writeCanonical(root, fixture.paths.current, changedAttestation);
    const changedAuthorization = authorization(fixture.values.candidate, [
      fixture.values.attestations[0],
      changedAttestation,
    ]);
    const authorizationReference = await writeCanonical(
      root,
      fixture.paths.authorization,
      changedAuthorization,
    );
    const bootstrap = {
      ...fixture.bootstrap,
      attestations: [
        fixture.bootstrap.attestations[0],
        { environmentId: "win11-current", artifact: reference },
      ],
      runAuthorization: authorizationReference,
    };
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, bootstrap),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_CONTROLLER_BINDING" });
  });

  it.each([
    {
      nativeHelperArtifactPath: "bin/nsis.exe",
      nsisArtifactPath: "bin/windows-host-falsifier-native.exe",
    },
    {
      nativeHelperArtifactPath: "bin/windows-host-falsifier-native.exe",
      nsisArtifactPath: "bin/missing-nsis.exe",
    },
    {
      nativeHelperArtifactPath: "bin/windows-host-falsifier-native.exe",
      nsisArtifactPath: "bin/windows-host-falsifier-native.exe",
    },
  ])(
    "rejects candidate binary locator drift: $nativeHelperArtifactPath / $nsisArtifactPath",
    async (candidateBinaries) => {
      const fixture = await createFixture(root);
      const bootstrap = { ...fixture.bootstrap, candidateBinaries };
      await expect(
        loadProbeBootstrap({
          root,
          expectedSha256: await rewriteBootstrap(fixture, bootstrap),
        }),
      ).rejects.toMatchObject({ code: "BOOTSTRAP_NATIVE_BINDING" });
    },
  );

  it("enforces the same tight bound on every inventory JSON", async () => {
    const fixture = await createFixture(root);
    const oversized = Buffer.alloc(PROBE_BOOTSTRAP_MAXIMUM_BYTES + 1, 0x20);
    await writeBytes(root, fixture.paths.lifecycle, oversized);
    const lifecycleReference = {
      path: fixture.paths.lifecycle,
      sha256: sha256(oversized),
    };
    const bootstrap = { ...fixture.bootstrap, lifecyclePolicy: lifecycleReference };
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, bootstrap),
      }),
    ).rejects.toMatchObject({ code: "PROBE_ADAPTER_BOUND" });
  });

  it("rejects noncanonical referenced JSON even when its external digest matches", async () => {
    const fixture = await createFixture(root);
    const bytes = Buffer.from(JSON.stringify(fixture.values.lifecycle), "utf8");
    await writeBytes(root, fixture.paths.lifecycle, bytes);
    const bootstrap = {
      ...fixture.bootstrap,
      lifecyclePolicy: { path: fixture.paths.lifecycle, sha256: sha256(bytes) },
    };
    await expect(
      loadProbeBootstrap({
        root,
        expectedSha256: await rewriteBootstrap(fixture, bootstrap),
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_CANONICAL" });
    expect(await readFile(join(root, fixture.paths.lifecycle))).toEqual(bytes);
  });
});
