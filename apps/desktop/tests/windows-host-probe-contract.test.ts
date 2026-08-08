import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  PROBE_CAMPAIGN_MANIFEST,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
  createExternalCheckpointReplayRegistry,
  deriveCandidateDigest,
  deriveExternalCheckpointReceiptDigest,
  deriveExternalCheckpointRequestDigest,
  deriveLabAttestationDigest,
  analyzeProbeCampaignRecords,
  deriveProbeContinuationScopeDigest,
  deriveProbeOutcomeEvidenceDigest,
  deriveProbeRowEvidenceDigest,
  deriveProbeRowVerificationInputDigest,
  deriveProbeSelectionDigest,
  deriveProbeSegmentDigest,
  deriveProbeVerificationInputDigest,
  hashProbeCanonicalJson,
  validateExternalCheckpointEvidence,
  validateLabAttestation,
  validateProbeCampaignManifest,
  validateProbeCandidateIdentity,
  validateProbeSegmentRecord,
  verifyExternalCheckpointRequestSignature,
  verifyExternalCheckpointReceiptSignature,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type {
  ProbeCandidateDigestFields,
  ProbeCandidateIdentity,
  ProbeExternalCheckpointEvidence,
  ProbeExternalCheckpointReceipt,
  ProbeExternalCheckpointRequest,
  ProbeLabAttestation,
  ProbeSegmentRecord,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";

type ProbeSegmentDraft = Omit<ProbeSegmentRecord, "segmentSha256">;

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const powerShellSha256 = "7".repeat(64);
const nsisSha256 = "6".repeat(64);
const controllerIdentitySha256 = "8".repeat(64);
const { privateKey: controllerPrivateKey, publicKey: controllerPublicKey } =
  generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerPublicKey.export({ format: "der", type: "spki" });
const controllerPublicKeySha256 = createHash("sha256")
  .update(controllerPublicKeyBytes)
  .digest("hex");

function candidate(overrides: Partial<ProbeCandidateDigestFields> = {}): ProbeCandidateIdentity {
  const fields: ProbeCandidateDigestFields = {
    schemaVersion: 1,
    kind: "windows-host-probe-candidate",
    repositoryCommit: "c".repeat(40),
    sourceHashes: [
      { path: "probe/native-helper.cs", sha256: shaA },
      { path: "probe/runner.mjs", sha256: shaB },
    ],
    binaryHashes: [{ path: "bin/native-helper.exe", sha256: "d".repeat(64) }],
    compiler: {
      provider: "Microsoft.CSharp.CSharpCodeProvider",
      codeDomProviderAssemblyVersion: "4.0.0.0",
      cscFileVersion: "4.8.9256.0",
      cscSha256: "8".repeat(64),
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
      powerShellExecutableSha256: powerShellSha256,
      clrVersion: "v4.0.30319",
      runtimeDirectorySha256Before: "9".repeat(64),
      runtimeDirectorySha256After: "9".repeat(64),
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
    configurationSha256: "e".repeat(64),
    ...overrides,
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
      patchLevel: "synthetic-contract-fixture",
      productType: "workstation",
      machineArchitecture: "x64",
      processArchitecture: "x64",
      systemVolumeFileSystem: "NTFS",
      systemVolumeIdSha256: "1".repeat(64),
      testVolumeFileSystem: "NTFS",
      testVolumeIdSha256: "2".repeat(64),
      standardUserSidSha256: "3".repeat(64),
      elevated: false,
      defenderRealtimeEnabled: true,
      uacDefault: true,
      developerModeEnabled: false,
    },
    snapshot: {
      vmImageId: `${environmentId}-image`,
      vmImageSha256: "4".repeat(64),
      vmSnapshotId: `${environmentId}-clean-snapshot`,
      cleanImageVersion: "2026.08.06.1",
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
      interactiveSessionOwnerSidSha256: "3".repeat(64),
    },
    runtime: {
      nodeVersion: "24.5.0",
      powerShellVersion: "5.1.26100.7705",
      powerShellEdition: "Desktop",
      powerShellExecutableSha256: powerShellSha256,
      clrVersion: "v4.0.30319",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      nsisExecutableSha256: nsisSha256,
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
          sha256: "5".repeat(64),
        },
      },
      {
        pathProfileId: "spaces-unicode",
        artifact: {
          path: `attestations/${environmentId}-spaces-unicode-guest.json`,
          sha256: "6".repeat(64),
        },
      },
    ],
    controllerEvidence: {
      path: `attestations/${environmentId}-controller.json`,
      sha256: environmentId === "win11-floor" ? shaB : shaA,
    },
  };
  return { ...fields, attestationSha256: deriveLabAttestationDigest(fields) };
}

function allAttestations(): ProbeLabAttestation[] {
  return PROBE_ENVIRONMENT_IDS.map((environmentId) => attestation(environmentId));
}

function executionBundleManifestSha256(environmentId: "win11-floor" | "win11-current") {
  return hashProbeCanonicalJson({ kind: "execution-bundle-manifest", environmentId });
}

function segment(
  identity: ProbeCandidateIdentity,
  environmentId: "win11-floor" | "win11-current",
  pathProfileId: "ascii" | "spaces-unicode",
  rowId: string,
  variantId: string,
  conditional: { conditionId: string } | null,
  binding: {
    mechanismId: string;
    mechanismDefinitionSha256: string;
    upstreamSelectionDigests: string[];
  },
): ProbeSegmentDraft {
  const evidencePath = `segments/${environmentId}/${pathProfileId}/${rowId.toLowerCase()}-${variantId}.json`;
  const mechanismPath = `mechanisms/${rowId.toLowerCase()}.json`;
  const verifierId = variantId.startsWith("f07-hard-cut-")
    ? ("hard-cut-probe-verifier-v1" as const)
    : ("native-probe-verifier-v1" as const);
  const verifierPath = `verifiers/${verifierId}.mjs`;
  const verifierSourceSha256 = hashProbeCanonicalJson({ verifierId, source: "contract fixture" });
  const observations = [
    {
      step: "criterion-observed",
      expected: conditional === null ? "criterion passes" : "conditional capability is observed",
      actual: conditional === null ? "criterion passed" : "capability unavailable",
      evidenceRef: evidencePath,
    },
  ];
  const artifactHashes = [
    { path: mechanismPath, sha256: binding.mechanismDefinitionSha256 },
    { path: evidencePath, sha256: "f".repeat(64) },
    { path: verifierPath, sha256: verifierSourceSha256 },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const verificationMetrics = [{ name: "criterion-count", unit: "count", value: 1 }] as const;
  const unavailability =
    conditional === null
      ? null
      : {
          conditionId: conditional.conditionId,
          observedUnavailable: true as const,
          reason: "Independent capability probe recorded that this conditional facility is absent.",
        };
  const outcome = conditional === null ? ("PASS" as const) : ("SKIP" as const);
  const verificationInputSha256 = deriveProbeVerificationInputDigest({
    campaignId: "f01-f10-native-probe-v1",
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: identity.candidateSha256,
    environmentId,
    pathProfileId,
    rowId,
    variantId,
    artifactHashes,
    verificationMetrics,
    verifierId,
    verifierSourceSha256,
  });
  const outcomeEvidenceSha256 = deriveProbeOutcomeEvidenceDigest({
    outcome,
    observations,
    artifactHashes,
    unavailability,
    verifierId,
    verifierSourceSha256,
    verificationInputSha256,
  });
  const base = {
    schemaVersion: 1,
    kind: "windows-host-probe-segment",
    campaignId: "f01-f10-native-probe-v1",
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: identity.candidateSha256,
    labAttestationSha256: attestation(environmentId).attestationSha256,
    environmentId,
    pathProfileId,
    rowId,
    variantId,
    phase: "probe",
    outcome,
    mechanismId: binding.mechanismId,
    mechanismDefinitionSha256: binding.mechanismDefinitionSha256,
    upstreamSelectionDigests: binding.upstreamSelectionDigests,
    verifierId,
    verifierSourceSha256,
    verificationMetrics,
    verificationInputSha256,
    outcomeEvidenceSha256,
    observations,
    artifactHashes,
    unavailability,
    provenance: {
      campaignRunId: "campaign-run-one",
      executionRunId: `execution-${environmentId}`,
      executionBundleId: `bundle-${environmentId}`,
      executionBundleManifestSha256: executionBundleManifestSha256(environmentId),
      attemptId: `attempt-${environmentId}-${pathProfileId}`,
      startedAt: "2026-08-06T10:00:00.000Z",
      endedAt: "2026-08-06T10:00:01.000Z",
      monotonicDurationMs: 1_000,
      vmSnapshotId: `${environmentId}-clean-snapshot`,
      bootIdSha256: environmentId === "win11-floor" ? "5".repeat(64) : "6".repeat(64),
      externalCheckpoints: [] as ProbeExternalCheckpointEvidence[],
    },
    rowClosureClaimed: false,
  } as const;
  const repetitions = variantId.startsWith("f07-hard-cut-") ? 5 : 1;
  const continuations: ProbeSegmentRecord["continuations"][number][] = [];
  const externalCheckpoints: ProbeExternalCheckpointEvidence[] = [];
  let preCutBootIdSha256 = base.provenance.bootIdSha256;
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const coordinate = {
      environmentId,
      pathProfileId,
      rowId,
      variantId,
      attemptId: base.provenance.attemptId,
      repetition,
    };
    const chainId = `chain-${hashProbeCanonicalJson(coordinate).slice(0, 32)}`;
    const scopeSha256 = deriveProbeContinuationScopeDigest({
      campaignId: base.campaignId,
      manifestSha256: base.manifestSha256,
      candidateSha256: base.candidateSha256,
      campaignRunId: base.provenance.campaignRunId,
      executionRunId: base.provenance.executionRunId,
      executionBundleId: base.provenance.executionBundleId,
      executionBundleManifestSha256: base.provenance.executionBundleManifestSha256,
      ...coordinate,
      chainId,
    });
    const headerSha256 = hashProbeCanonicalJson({ kind: "continuation-header", scopeSha256 });
    const terminalEntrySha256 = hashProbeCanonicalJson({
      kind: "continuation-terminal",
      scopeSha256,
    });
    let receiptSha256 = hashProbeCanonicalJson({ kind: "continuation-receipt", scopeSha256 });
    if (repetitions === 5) {
      const requestDraft = {
        schemaVersion: 1 as const,
        kind: "windows-host-probe-hard-cut-request" as const,
        campaignId: base.campaignId,
        manifestSha256: base.manifestSha256,
        candidateSha256: base.candidateSha256,
        campaignRunId: base.provenance.campaignRunId,
        executionRunId: base.provenance.executionRunId,
        executionBundleId: base.provenance.executionBundleId,
        executionBundleManifestSha256: base.provenance.executionBundleManifestSha256,
        attemptId: base.provenance.attemptId,
        environmentId,
        pathProfileId,
        rowId,
        variantId,
        checkpointId: `checkpoint-${repetition}`,
        sequence: repetition,
        nonceSha256: hashProbeCanonicalJson({ kind: "checkpoint-nonce", scopeSha256 }),
        preCutStateSha256: hashProbeCanonicalJson({ kind: "pre-cut-state", scopeSha256 }),
        preCutBootIdSha256,
        sourceVmSnapshotId: base.provenance.vmSnapshotId,
        continuationScopeSha256: scopeSha256,
        controllerIdentitySha256,
        controllerPublicKeySha256,
        controllerVersion: "1.2.3",
        action: "hard-power-cut" as const,
        signatureAlgorithm: "Ed25519" as const,
      };
      const requestSha256 = deriveExternalCheckpointRequestDigest(requestDraft);
      const request = {
        ...requestDraft,
        signatureBase64: sign(
          null,
          Buffer.from(requestSha256, "hex"),
          controllerPrivateKey,
        ).toString("base64"),
        requestSha256,
      };
      const receiptDraft = {
        schemaVersion: 1 as const,
        kind: "windows-host-probe-hard-cut-receipt" as const,
        requestSha256: request.requestSha256,
        controllerIdentitySha256,
        controllerPublicKeySha256,
        controllerVersion: "1.2.3",
        action: "hard-power-cut" as const,
        powerCutAt: "2026-08-06T10:00:00.250Z",
        bootStartedAt: "2026-08-06T10:00:00.500Z",
        bootCompletedAt: "2026-08-06T10:00:01.000Z",
        postBootVmSnapshotId: base.provenance.vmSnapshotId,
        preCutBootIdSha256,
        postBootBootIdSha256: hashProbeCanonicalJson({ kind: "post-boot", scopeSha256 }),
        artifactHashes: [
          {
            path: `checkpoints/${environmentId}/${pathProfileId}/${variantId}/${repetition}.json`,
            sha256: hashProbeCanonicalJson({ kind: "checkpoint-artifact", scopeSha256 }),
          },
        ],
        signatureAlgorithm: "Ed25519" as const,
      };
      receiptSha256 = deriveExternalCheckpointReceiptDigest(receiptDraft);
      const receipt = {
        ...receiptDraft,
        signatureBase64: sign(
          null,
          Buffer.from(receiptSha256, "hex"),
          controllerPrivateKey,
        ).toString("base64"),
        receiptSha256,
      };
      preCutBootIdSha256 = receipt.postBootBootIdSha256;
      externalCheckpoints.push({ request, receipt });
    }
    continuations.push({
      repetition,
      chainId,
      scopeSha256,
      headerSha256,
      terminalEntrySha256,
      receiptSha256,
    });
  }
  return {
    ...base,
    provenance: { ...base.provenance, externalCheckpoints },
    continuations,
  };
}

function resignSegment(segmentRecord: ProbeSegmentDraft | ProbeSegmentRecord): ProbeSegmentRecord {
  return {
    ...segmentRecord,
    segmentSha256: deriveProbeSegmentDigest(segmentRecord),
  };
}

function resignCheckpointRequest(
  request: ProbeExternalCheckpointRequest,
  overrides: Partial<ProbeExternalCheckpointRequest> = {},
): ProbeExternalCheckpointRequest {
  const {
    requestSha256: _requestSha256,
    signatureBase64: _signatureBase64,
    ...draft
  } = { ...request, ...overrides };
  const requestSha256 = deriveExternalCheckpointRequestDigest(draft);
  return {
    ...draft,
    signatureBase64: sign(null, Buffer.from(requestSha256, "hex"), controllerPrivateKey).toString(
      "base64",
    ),
    requestSha256,
  };
}

function resignCheckpointReceipt(
  receipt: ProbeExternalCheckpointReceipt,
  overrides: Partial<ProbeExternalCheckpointReceipt> = {},
): ProbeExternalCheckpointReceipt {
  const {
    receiptSha256: _receiptSha256,
    signatureBase64: _signatureBase64,
    ...draft
  } = { ...receipt, ...overrides };
  const receiptSha256 = deriveExternalCheckpointReceiptDigest(draft);
  return {
    ...draft,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), controllerPrivateKey).toString(
      "base64",
    ),
    receiptSha256,
  };
}

function replaceHardCutCheckpoint(
  record: ProbeSegmentRecord,
  index: number,
  checkpoint: ProbeExternalCheckpointEvidence,
): ProbeSegmentRecord {
  const externalCheckpoints = [...record.provenance.externalCheckpoints];
  externalCheckpoints[index] = checkpoint;
  const continuations = [...record.continuations];
  continuations[index] = {
    ...continuations[index],
    receiptSha256: checkpoint.receipt.receiptSha256,
  };
  return resignSegment({
    ...record,
    provenance: { ...record.provenance, externalCheckpoints },
    continuations,
  });
}

function hardCutSegment(identity = candidate()): ProbeSegmentRecord {
  const mechanismId = "mechanism-f-07";
  const mechanismDefinitionSha256 = hashProbeCanonicalJson({
    rowId: "F-07",
    mechanismId,
    definition: "synthetic hard-cut contract fixture",
  });
  return resignSegment(
    segment(identity, "win11-floor", "ascii", "F-07", "f07-hard-cut-after-file-flush", null, {
      mechanismId,
      mechanismDefinitionSha256,
      upstreamSelectionDigests: [],
    }),
  );
}

function resignOutcome(segmentRecord: ProbeSegmentRecord): ProbeSegmentRecord {
  const withOutcomeDigest = {
    ...segmentRecord,
    outcomeEvidenceSha256: deriveProbeOutcomeEvidenceDigest(segmentRecord),
  };
  return resignSegment(withOutcomeDigest);
}

function resignRecords(records: readonly ProbeSegmentRecord[]): ProbeSegmentRecord[] {
  return records.map(resignSegment);
}

function fullMatrix(identity: ProbeCandidateIdentity): ProbeSegmentRecord[] {
  const selectionDigests = new Map<string, string>();
  const records: ProbeSegmentRecord[] = [];
  for (const row of PROBE_CAMPAIGN_MANIFEST.rows) {
    const mechanismId = `mechanism-${row.rowId.toLowerCase()}`;
    const mechanismDefinitionSha256 = hashProbeCanonicalJson({
      rowId: row.rowId,
      mechanismId,
      definition: "synthetic in-memory contract fixture",
    });
    const upstreamSelectionDigests = row.dependsOnRowIds
      .map((rowId) => selectionDigests.get(rowId))
      .filter((digest): digest is string => digest !== undefined)
      .sort();
    const variants = [
      ...row.requiredVariantIds.map((variantId) => ({ variantId, conditional: null })),
      ...row.conditionalVariants.map((variant) => ({
        variantId: variant.variantId,
        conditional: { conditionId: variant.conditionId },
      })),
    ];
    const rowRecords = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
      PROBE_PATH_PROFILE_IDS.flatMap((pathProfileId) =>
        variants.map((variant) =>
          resignSegment(
            segment(
              identity,
              environmentId,
              pathProfileId,
              row.rowId,
              variant.variantId,
              variant.conditional,
              { mechanismId, mechanismDefinitionSha256, upstreamSelectionDigests },
            ),
          ),
        ),
      ),
    );
    const verifierBindings = [
      ...new Map(
        rowRecords.map((record) => [
          record.verifierId,
          { verifierId: record.verifierId, verifierSourceSha256: record.verifierSourceSha256 },
        ]),
      ).values(),
    ].sort((left, right) => Buffer.from(left.verifierId).compare(Buffer.from(right.verifierId)));
    const verificationInputSha256 = deriveProbeRowVerificationInputDigest(
      row.rowId,
      rowRecords.map((record) => record.verificationInputSha256).sort(),
    );
    const rowEvidenceSha256 = deriveProbeRowEvidenceDigest({
      rowId: row.rowId,
      terminalSegmentDigests: rowRecords.map((record) => record.segmentSha256).sort(),
      attestationDigests: allAttestations()
        .map((entry) => entry.attestationSha256)
        .sort(),
      executionBundleManifestDigests: PROBE_ENVIRONMENT_IDS.map((environmentId) =>
        executionBundleManifestSha256(environmentId),
      ).sort(),
    });
    selectionDigests.set(
      row.rowId,
      deriveProbeSelectionDigest({
        rowId: row.rowId,
        candidateSha256: identity.candidateSha256,
        mechanismId,
        mechanismDefinitionSha256,
        upstreamSelectionDigests,
        verifierBindings,
        verificationInputSha256,
        rowEvidenceSha256,
      }),
    );
    records.push(...rowRecords);
  }
  return records;
}

function aggregate(identity: ProbeCandidateIdentity, segments: ProbeSegmentRecord[]) {
  return analyzeProbeCampaignRecords({
    manifest: PROBE_CAMPAIGN_MANIFEST,
    candidate: identity,
    attestations: allAttestations(),
    segments,
  });
}

describe("Windows host probe campaign contract", () => {
  it("loads the immutable F-01 through F-10 manifest fixture and freezes QA parameters", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/windows-host/probe-campaign.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;

    expect(validateProbeCampaignManifest(fixture)).toEqual(PROBE_CAMPAIGN_MANIFEST);
    expect(PROBE_CAMPAIGN_MANIFEST.rows.map((row) => row.rowId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `F-${String(index + 1).padStart(2, "0")}`),
    );
    expect(PROBE_CAMPAIGN_MANIFEST.environmentIds).toEqual(["win11-floor", "win11-current"]);
    expect(PROBE_CAMPAIGN_MANIFEST.pathProfileIds).toEqual(["ascii", "spaces-unicode"]);
    expect(PROBE_CAMPAIGN_MANIFEST.parameters).toMatchObject({
      f04Race: { durationMs: 30_000, minimumSwapCount: 10_000 },
      f06Replacement: { rapidReaderCount: 16, maxRetries: 8, retryDeadlineMs: 3_000 },
      f07Durability: { repetitionsPerHardCutCheckpoint: 5 },
      f08UpgradeFence: { capabilityBytes: 32, ordinaryStarterCount: 20, raceIterations: 1_000 },
      f09Lifecycle: { pidPressureCount: 20_000, pidPressureDeadlineMs: 120_000 },
      f10Singleton: { starterCount: 32, raceRounds: 100, contentionTimeoutMs: 10_000 },
    });
    expect(() => {
      const mutable = structuredClone(PROBE_CAMPAIGN_MANIFEST) as unknown as {
        parameters: { f10Singleton: { starterCount: number } };
      };
      mutable.parameters.f10Singleton.starterCount = 31;
      validateProbeCampaignManifest(mutable);
    }).toThrow(/frozen F-01 through F-10 contract/u);
  });

  it("derives one deterministic candidate and manifest hash from canonical JSON", () => {
    const identity = candidate();
    expect(validateProbeCandidateIdentity(identity)).toEqual(identity);
    expect(identity.candidateSha256).toBe(deriveCandidateDigest(identity));
    expect(PROBE_CAMPAIGN_MANIFEST_SHA256).toBe(hashProbeCanonicalJson(PROBE_CAMPAIGN_MANIFEST));
    expect(canonicalProbeJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      canonicalProbeJson({ a: { b: 3, y: 2 }, z: 1 }),
    );
  });

  it("selects mechanisms only after the same candidate passes the complete two-VM/two-path matrix", () => {
    const identity = candidate();
    const result = aggregate(identity, fullMatrix(identity));

    expect(result.status).toBe("PASS");
    expect(result.selectionEligible).toBe(false);
    expect(result.rowClosureClaimed).toBe(false);
    expect(result.rowResults).toHaveLength(10);
    expect(result.rowResults.every((row) => row.status === "PASS")).toBe(true);
    expect(result.rowResults.every((row) => row.selectedMechanism !== null)).toBe(true);
    expect(result.rowResults.every((row) => row.rowEvidenceSha256 !== null)).toBe(true);
    expect(result.rowResults.every((row) => row.rowClosureClaimed === false)).toBe(true);
    expect(
      result.rowResults.every((row) => row.observedSegmentCount === row.expectedSegmentCount),
    ).toBe(true);
    expect(result.rowResults.find((row) => row.rowId === "F-07")?.verifierBindings).toHaveLength(2);

    expect(aggregate(identity, [...fullMatrix(identity)].reverse())).toEqual(result);
  }, 30_000);

  it("derives FAIL ahead of missing or inconclusive coverage and never selects a failed row", () => {
    const identity = candidate();
    const original = fullMatrix(identity);
    original[0] = resignOutcome({ ...original[0], outcome: "FAIL" });
    original.pop();
    const segments = resignRecords(original);

    const result = aggregate(identity, segments);
    expect(result.status).toBe("FAIL");
    expect(result.selectionEligible).toBe(false);
    expect(result.rowResults.find((row) => row.rowId === "F-01")).toMatchObject({
      status: "FAIL",
      selectedMechanism: null,
    });
  });

  it("derives INCONCLUSIVE for missing matrix coverage, missing attestations, or unavailable prerequisites", () => {
    const identity = candidate();
    const missing = resignRecords(fullMatrix(identity).slice(1));
    const missingResult = aggregate(identity, missing);
    expect(missingResult.status).toBe("INCONCLUSIVE");
    const missingRow = missingResult.rowResults.find((row) => row.rowId === "F-01");
    expect(missingRow?.missingSegments).toHaveLength(1);
    expect((missingRow?.expectedSegmentCount ?? 0) - (missingRow?.observedSegmentCount ?? 0)).toBe(
      1,
    );

    const withoutFloor = analyzeProbeCampaignRecords({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate: identity,
      attestations: [attestation("win11-current")],
      segments: fullMatrix(identity),
    });
    expect(withoutFloor.status).toBe("INCONCLUSIVE");
    expect(withoutFloor.issues).toContainEqual({
      code: "MISSING_ATTESTATION",
      detail: "win11-floor",
    });

    const unavailable = {
      ...attestation("win11-floor"),
      capabilities: {
        ...attestation("win11-floor").capabilities,
        externalAbruptPower: false,
      },
    };
    unavailable.attestationSha256 = deriveLabAttestationDigest(unavailable);
    const unavailableResult = analyzeProbeCampaignRecords({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate: identity,
      attestations: [unavailable, attestation("win11-current")],
      segments: resignRecords(
        fullMatrix(identity).map((record) =>
          record.environmentId === "win11-floor"
            ? { ...record, labAttestationSha256: unavailable.attestationSha256 }
            : record,
        ),
      ),
    });
    expect(unavailableResult.status).toBe("INCONCLUSIVE");
    expect(unavailableResult.selectionEligible).toBe(false);

    const untrustedFailureRecords = fullMatrix(identity).map((record, index) => {
      const rebound =
        record.environmentId === "win11-floor"
          ? { ...record, labAttestationSha256: unavailable.attestationSha256 }
          : record;
      return index === 0 ? resignOutcome({ ...rebound, outcome: "FAIL" }) : rebound;
    });
    const untrustedFailure = analyzeProbeCampaignRecords({
      manifest: PROBE_CAMPAIGN_MANIFEST,
      candidate: identity,
      attestations: [unavailable, attestation("win11-current")],
      segments: resignRecords(untrustedFailureRecords),
    });
    expect(untrustedFailure.status).toBe("INCONCLUSIVE");
    expect(untrustedFailure.rowResults.every((row) => row.selectedMechanism === null)).toBe(true);
  }, 30_000);

  it("refuses duplicate/case-colliding segments and candidate artifact identities", () => {
    const identity = candidate();
    const segments = fullMatrix(identity);
    expect(() => aggregate(identity, [...segments, segments[0]])).toThrow(
      /duplicate\/case-colliding/u,
    );

    const collisionFields = {
      ...identity,
      candidateSha256: undefined,
      sourceHashes: [
        { path: "probe/Runner.mjs", sha256: shaA },
        { path: "probe/runner.mjs", sha256: shaB },
      ],
    };
    delete collisionFields.candidateSha256;
    const colliding = {
      ...collisionFields,
      candidateSha256: deriveCandidateDigest(collisionFields as ProbeCandidateDigestFields),
    };
    expect(() => validateProbeCandidateIdentity(colliding)).toThrow(/duplicate\/case collision/u);
  });

  it("refuses forged manifest, candidate, and lab-attestation bindings", () => {
    const identity = candidate();
    const segments = fullMatrix(identity);
    expect(() =>
      validateProbeSegmentRecord({ ...segments[0], manifestSha256: "0".repeat(64) }),
    ).toThrow(/frozen campaign manifest/u);
    expect(() =>
      validateProbeCandidateIdentity({ ...identity, candidateSha256: "0".repeat(64) }),
    ).toThrow(/does not bind/u);
    expect(() =>
      validateLabAttestation({
        ...attestation("win11-floor"),
        host: { ...attestation("win11-floor").host, osBuild: "26101" },
      }),
    ).toThrow(/does not bind the sanitized attestation payload/u);
    expect(() =>
      aggregate(
        identity,
        resignRecords([
          { ...segments[0], labAttestationSha256: "0".repeat(64) },
          ...segments.slice(1),
        ]),
      ),
    ).toThrow(/lab-attestation hash/u);
  });

  it("refuses an inaccurate compiler target and binds the actual Add-Type CodeDOM runtime", () => {
    const identity = candidate();
    expect(identity.compiler).toMatchObject({
      provider: "Microsoft.CSharp.CSharpCodeProvider",
      outputType: "ConsoleApplication",
      platform: "x64",
    });
    expect(identity.toolchain).toMatchObject({
      powerShellEdition: "Desktop",
      updaterVersion: "6.6.2",
    });
    expect(() =>
      validateProbeCandidateIdentity({
        ...identity,
        compiler: { ...identity.compiler, platform: "AnyCPU" },
      }),
    ).toThrow(/CodeDOM ConsoleApplication x64 target/u);
  });

  it("propagates dependency blocks and exposes standard probe summaries without closure claims", () => {
    const identity = candidate();
    const segments = fullMatrix(identity);
    const f01Index = segments.findIndex((entry) => entry.rowId === "F-01");
    segments[f01Index] = resignOutcome({ ...segments[f01Index], outcome: "FAIL" });
    const result = aggregate(identity, resignRecords(segments));

    expect(result.status).toBe("FAIL");
    expect(result.rowResults.find((row) => row.rowId === "F-02")).toMatchObject({
      status: "INCONCLUSIVE",
      stopConditionTriggered: true,
      blockedByRowIds: ["F-01"],
      selectionDigest: null,
    });
    expect(result.rowResults.find((row) => row.rowId === "F-03")?.blockedByRowIds).toEqual([
      "F-02",
    ]);
    const independent = result.rowResults.find((row) => row.rowId === "F-09");
    expect(independent).toMatchObject({
      status: "PASS",
      stopConditionTriggered: false,
      rowClosureClaimed: false,
    });
    expect(independent?.claim).toBeTruthy();
    expect(independent?.stopCondition).toBeTruthy();
    expect(independent?.selectionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(independent?.environmentEvidenceRefs).toHaveLength(4);
  });

  it("derives campaign status after dependency blocking, even when a blocked row observed FAIL", () => {
    const identity = candidate();
    const records = fullMatrix(identity);
    const missingF01 = records.findIndex((entry) => entry.rowId === "F-01");
    records.splice(missingF01, 1);
    const failingF02 = records.findIndex((entry) => entry.rowId === "F-02");
    records[failingF02] = resignOutcome({ ...records[failingF02], outcome: "FAIL" });

    const result = aggregate(identity, records);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.rowResults.find((row) => row.rowId === "F-02")).toMatchObject({
      status: "INCONCLUSIVE",
      blockedByRowIds: ["F-01"],
      selectedMechanism: null,
      rowEvidenceSha256: null,
    });
  });

  it("requires a signed five-cut chain with an adjacent new boot identity after every cut", () => {
    const hardCut = hardCutSegment();
    expect(hardCut.provenance.externalCheckpoints).toHaveLength(5);
    const registry = createExternalCheckpointReplayRegistry();
    let expectedPreCutBootIdSha256 = hardCut.provenance.bootIdSha256;
    for (const [index, checkpoint] of hardCut.provenance.externalCheckpoints.entries()) {
      expect(
        verifyExternalCheckpointRequestSignature(checkpoint.request, controllerPublicKeyBytes),
      ).toEqual(checkpoint.request);
      expect(
        verifyExternalCheckpointReceiptSignature(checkpoint.receipt, controllerPublicKeyBytes),
      ).toEqual(checkpoint.receipt);
      expect(
        validateExternalCheckpointEvidence(checkpoint, {
          segment: hardCut,
          continuation: hardCut.continuations[index],
          repetition: index + 1,
          replayRegistry: registry,
          expectedController: attestation(hardCut.environmentId).controller,
          controllerPublicKeyBytes,
          expectedPreCutBootIdSha256,
        }),
      ).toEqual(checkpoint);
      expect(checkpoint.request.preCutBootIdSha256).toBe(expectedPreCutBootIdSha256);
      expect(checkpoint.receipt.preCutBootIdSha256).toBe(expectedPreCutBootIdSha256);
      expect(checkpoint.receipt.postBootBootIdSha256).not.toBe(expectedPreCutBootIdSha256);
      expectedPreCutBootIdSha256 = checkpoint.receipt.postBootBootIdSha256;
    }
    expect(validateProbeSegmentRecord(hardCut)).toEqual(hardCut);
    const checkpoint = hardCut.provenance.externalCheckpoints[0];
    expect(() =>
      validateExternalCheckpointEvidence(checkpoint, {
        segment: hardCut,
        continuation: hardCut.continuations[0],
        repetition: 1,
        replayRegistry: registry,
        controllerPublicKeyBytes,
      }),
    ).toThrow(/replayed/u);
    expect(() =>
      validateProbeSegmentRecord(
        resignSegment({
          ...hardCut,
          provenance: { ...hardCut.provenance, externalCheckpoints: [] },
        }),
      ),
    ).toThrow(/requires exactly 5 external checkpoints/u);
  });

  it("rejects a forged hard-cut request signature even when its request digest is unchanged", () => {
    const hardCut = hardCutSegment();
    const request = hardCut.provenance.externalCheckpoints[0].request;
    const forgedSignatureBytes = Buffer.from(request.signatureBase64, "base64");
    forgedSignatureBytes[0] ^= 1;
    expect(() =>
      verifyExternalCheckpointRequestSignature(
        { ...request, signatureBase64: forgedSignatureBytes.toString("base64") },
        controllerPublicKeyBytes,
      ),
    ).toThrow(/signature verification failed/u);
    expect(deriveExternalCheckpointRequestDigest(request)).toBe(request.requestSha256);
  });

  it("rejects a correctly signed first cut whose pre-cut boot is not segment provenance", () => {
    const hardCut = hardCutSegment();
    const original = hardCut.provenance.externalCheckpoints[0];
    const wrongPreCutBootIdSha256 = "9".repeat(64);
    const request = resignCheckpointRequest(original.request, {
      preCutBootIdSha256: wrongPreCutBootIdSha256,
    });
    const receipt = resignCheckpointReceipt(original.receipt, {
      requestSha256: request.requestSha256,
      preCutBootIdSha256: wrongPreCutBootIdSha256,
    });
    const forged = replaceHardCutCheckpoint(hardCut, 0, { request, receipt });
    expect(() => validateProbeSegmentRecord(forged)).toThrow(
      /pre-cut boot identity breaks the segment boot chain/u,
    );
  });

  it("rejects a correctly signed later cut that is not adjacent to the previous post-boot", () => {
    const hardCut = hardCutSegment();
    const original = hardCut.provenance.externalCheckpoints[1];
    const wrongPreCutBootIdSha256 = "9".repeat(64);
    const request = resignCheckpointRequest(original.request, {
      preCutBootIdSha256: wrongPreCutBootIdSha256,
    });
    const receipt = resignCheckpointReceipt(original.receipt, {
      requestSha256: request.requestSha256,
      preCutBootIdSha256: wrongPreCutBootIdSha256,
    });
    const forged = replaceHardCutCheckpoint(hardCut, 1, { request, receipt });
    expect(() => validateProbeSegmentRecord(forged)).toThrow(
      /pre-cut boot identity breaks the segment boot chain/u,
    );
  });

  it("rejects a correctly signed receipt whose pre-cut boot differs from its request", () => {
    const hardCut = hardCutSegment();
    const original = hardCut.provenance.externalCheckpoints[0];
    const receipt = resignCheckpointReceipt(original.receipt, {
      preCutBootIdSha256: "9".repeat(64),
    });
    const forged = replaceHardCutCheckpoint(hardCut, 0, {
      request: original.request,
      receipt,
    });
    expect(() => validateProbeSegmentRecord(forged)).toThrow(/does not answer its request/u);
  });

  it("rejects a correctly signed receipt that reports the same pre-cut and post-boot identity", () => {
    const hardCut = hardCutSegment();
    const original = hardCut.provenance.externalCheckpoints[0];
    const receipt = resignCheckpointReceipt(original.receipt, {
      postBootBootIdSha256: original.request.preCutBootIdSha256,
    });
    const forged = replaceHardCutCheckpoint(hardCut, 0, {
      request: original.request,
      receipt,
    });
    expect(() => validateProbeSegmentRecord(forged)).toThrow(/different post-boot identity/u);
  });

  it("rejects a forged signed receipt and forged segment provenance", () => {
    const identity = candidate();
    const records = fullMatrix(identity);
    const hardCut = records.find((entry) => entry.variantId.startsWith("f07-hard-cut-"));
    if (hardCut === undefined) throw new Error("hard-cut fixture missing");
    const checkpoint = hardCut.provenance.externalCheckpoints[0];
    const forgedSignatureBytes = Buffer.from(checkpoint.receipt.signatureBase64, "base64");
    forgedSignatureBytes[0] ^= 1;
    expect(() =>
      verifyExternalCheckpointReceiptSignature(
        { ...checkpoint.receipt, signatureBase64: forgedSignatureBytes.toString("base64") },
        controllerPublicKeyBytes,
      ),
    ).toThrow(/signature verification failed/u);
    expect(() =>
      validateProbeSegmentRecord({
        ...records[0],
        provenance: { ...records[0].provenance, vmSnapshotId: "forged-snapshot" },
      }),
    ).toThrow(/does not bind the per-variant evidence record/u);
  });

  it("rejects continuation evidence replay across otherwise independent coordinates", () => {
    const identity = candidate();
    const records = fullMatrix(identity);
    const first = records.findIndex((entry) => !entry.variantId.startsWith("f07-hard-cut-"));
    const second = records.findIndex(
      (entry, index) => index > first && !entry.variantId.startsWith("f07-hard-cut-"),
    );
    records[second] = resignSegment({
      ...records[second],
      continuations: [
        {
          ...records[second].continuations[0],
          headerSha256: records[first].continuations[0].headerSha256,
        },
      ],
    });
    expect(() => aggregate(identity, records)).toThrow(/continuation evidence was reused/u);
  });

  it("refuses forged upstream selection binding", () => {
    const identity = candidate();
    const records = fullMatrix(identity).map((entry) =>
      entry.rowId === "F-02" ? { ...entry, upstreamSelectionDigests: ["0".repeat(64)] } : entry,
    );
    expect(() => aggregate(identity, resignRecords(records))).toThrow(
      /does not bind the selected dependency digests/u,
    );
  });

  it("refuses mixed candidates and mixed row mechanisms", () => {
    const identity = candidate();
    const segments = fullMatrix(identity);
    const otherIdentity = candidate({ configurationSha256: "0".repeat(64) });
    expect(() => aggregate(identity, fullMatrix(otherIdentity))).toThrow(/candidate differs/u);
    expect(() =>
      aggregate(
        identity,
        resignRecords([
          { ...segments[0], mechanismId: "different-mechanism" },
          ...segments.slice(1),
        ]),
      ),
    ).toThrow(/more than one mechanism/u);
  });

  it("keeps an otherwise complete campaign INCONCLUSIVE when toolchain identity is unpinned", () => {
    const unpinned = candidate({
      toolchain: {
        nodeVersion: "latest",
        electronVersion: "43.1.1",
        electronBuilderVersion: "26.15.3",
        updaterVersion: "6.6.2",
        nsisVersion: "3.11.0",
        powerShellVersion: "5.1.26100.7705",
        powerShellEdition: "Desktop",
        powerShellExecutableSha256: powerShellSha256,
        clrVersion: "v4.0.30319",
        runtimeDirectorySha256Before: "9".repeat(64),
        runtimeDirectorySha256After: "9".repeat(64),
        runtimeRelativeInventory: [
          "System.Core.dll",
          "System.Security.dll",
          "System.Web.Extensions.dll",
          "System.dll",
          "csc.exe",
        ],
      },
    });
    const result = aggregate(unpinned, fullMatrix(unpinned));
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.selectionEligible).toBe(false);
    expect(result.issues).toContainEqual({
      code: "UNPINNED_VERSION",
      detail: "candidate.toolchain.nodeVersion",
    });
    expect(() => validateProbeCandidateIdentity(unpinned)).toThrow(/not fully pinned/u);
  });

  it("permits only evidenced conditional skips and never skips a required variant", () => {
    const identity = candidate();
    const conditional = fullMatrix(identity).find((entry) => entry.outcome === "SKIP");
    expect(conditional).toBeDefined();
    if (conditional === undefined) throw new Error("conditional fixture missing");
    expect(validateProbeSegmentRecord(conditional)).toEqual(conditional);
    expect(() =>
      validateProbeSegmentRecord(resignOutcome({ ...conditional, unavailability: null })),
    ).toThrow(/expected an object|observed-unavailable/u);

    const required = fullMatrix(identity).find((entry) => entry.outcome === "PASS");
    expect(required).toBeDefined();
    if (required === undefined) throw new Error("required fixture missing");
    expect(() =>
      validateProbeSegmentRecord(
        resignOutcome({
          ...required,
          outcome: "SKIP",
          unavailability: {
            conditionId: "fabricated-condition",
            observedUnavailable: true,
            reason: "Fabricated skip must be refused.",
          },
        }),
      ),
    ).toThrow(/required variant cannot be skipped/u);
  });

  it("requires exact keys and sanitized attestations without raw identity fields", () => {
    expect(validateLabAttestation(attestation("win11-floor"))).toEqual(attestation("win11-floor"));
    expect(() => validateLabAttestation({ ...attestation("win11-floor"), userSid: "raw" })).toThrow(
      /unexpected key/u,
    );
    expect(() =>
      validateLabAttestation({ ...attestation("win11-floor"), sanitized: false }),
    ).toThrow(/must be sanitized/u);
    expect(() => validateProbeCandidateIdentity({ ...candidate(), extra: true })).toThrow(
      /unexpected key/u,
    );
  });

  it("requires one exact sorted and distinct guest evidence artifact per path profile", () => {
    const valid = attestation("win11-floor");
    const [ascii, unicode] = valid.guestEvidenceByPathProfile;
    const malformedCollections = [
      [ascii],
      [unicode, ascii],
      [{ ...ascii, pathProfileId: "ASCII" }, unicode],
      [ascii, { ...unicode, pathProfileId: "ascii" }],
      [
        ascii,
        {
          ...unicode,
          artifact: { ...unicode.artifact, path: ascii.artifact.path.toUpperCase() },
        },
      ],
      [ascii, { ...unicode, artifact: { ...unicode.artifact, sha256: ascii.artifact.sha256 } }],
    ];

    for (const guestEvidenceByPathProfile of malformedCollections) {
      const malformed = { ...valid, guestEvidenceByPathProfile };
      malformed.attestationSha256 = deriveLabAttestationDigest(malformed);
      expect(() => validateLabAttestation(malformed)).toThrowError(
        expect.objectContaining({ code: "ATTESTATION_GUEST_EVIDENCE" }),
      );
    }

    const changedUnicode = {
      ...valid,
      guestEvidenceByPathProfile: [
        ascii,
        {
          ...unicode,
          artifact: { ...unicode.artifact, sha256: "7".repeat(64) },
        },
      ],
    };
    expect(deriveLabAttestationDigest(changedUnicode)).not.toBe(valid.attestationSha256);
  });
});
