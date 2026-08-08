import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROBE_TRANSCRIPT_FACT_DEFINITIONS,
  PROBE_VERIFIER_DEFINITIONS,
  PROBE_VERIFIER_SOURCE_PATH,
  getProbeTranscriptFactDefinition,
  getProbeVerifierDefinition,
  verifyProbeFacts,
} from "../scripts/windows-host-falsifier/probe-registry.mjs";
import { hashProbeCanonicalJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type {
  ProbeArtifactHash,
  ProbeCampaignManifest,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type {
  ProbeF01Facts,
  ProbeF02Facts,
  ProbeF03Facts,
  ProbeF04Facts,
  ProbeF05Facts,
  ProbeF06Facts,
  ProbeF07Facts,
  ProbeF08Facts,
  ProbeF09Facts,
  ProbeF10Facts,
  ProbeRawFactEnvelope,
  ProbeRowFacts,
} from "../scripts/windows-host-falsifier/probe-registry.mjs";

const sourceSha256 = "a".repeat(64);
const sourceTranscriptSha256 = "b".repeat(64);
const shaC = "c".repeat(64);
const shaD = "d".repeat(64);
const shaE = "e".repeat(64);
const endpointSuffix = "6".repeat(64);
const endpointName = `\\\\.\\pipe\\Enduragent-upgrade-v1-${endpointSuffix}`;
const endpointNameSha256 = createHash("sha256").update(endpointName, "utf8").digest("hex");

function rawFacts<T extends ProbeRowFacts>(
  rowId: string,
  variantId: string,
  facts: T,
  overrides: Partial<Pick<ProbeRawFactEnvelope<T>, "availability" | "captureComplete">> = {},
): ProbeRawFactEnvelope<T> {
  const definition = getProbeVerifierDefinition(rowId, variantId);
  const captureComplete = overrides.captureComplete ?? true;
  const availability = overrides.availability ?? { status: "available", reason: null };
  const transcript = {
    schemaVersion: 1 as const,
    kind: definition.transcriptKind,
    rowId,
    variantId,
    verifierDefinitionSha256: definition.definitionSha256,
    commandIds: [...definition.transcriptCommandIds],
    sourceTranscriptSha256,
    factsSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-transcript-facts.v1",
      rowId,
      variantId,
      facts,
    }),
    captureSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-transcript-capture.v1",
      rowId,
      variantId,
      schemaVersion: 1,
      kind: "windows-host-probe-raw-facts",
      captureComplete,
      availability,
      facts,
    }),
  };
  return {
    schemaVersion: 1,
    kind: "windows-host-probe-raw-facts",
    captureComplete,
    availability,
    scenario: {
      variantId,
      definitionSha256: definition.definitionSha256,
      evidenceSha256: sourceTranscriptSha256,
      transcript,
    },
    facts,
  };
}

function artifactHashesFor(
  facts: ProbeRawFactEnvelope<ProbeRowFacts>,
  extra: readonly ProbeArtifactHash[] = [],
): ProbeArtifactHash[] {
  return [
    { path: PROBE_VERIFIER_SOURCE_PATH, sha256: sourceSha256 },
    { path: "evidence/source-transcript.json", sha256: facts.scenario.evidenceSha256 },
    ...extra,
  ].sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
}

const f01Facts: ProbeF01Facts = {
  pathTopology: "actual-component-case-alias",
  processRole: "main",
  lifecycle: "same-process",
  credentialReadAttempted: false,
  canonicalIdentitySha256: shaC,
  comparisonIdentitySha256: shaC,
  localPathSha256: shaD,
  volumeIdentitySha256: shaE,
  volumeFileSystem: "NTFS",
  volumeDriveType: "fixed",
  win32Error: null,
  reasonCode: null,
};

const f02Facts: ProbeF02Facts = {
  rootClass: "fresh-private",
  actor: "current-user",
  operation: "create",
  operationApplied: true,
  win32Error: null,
  reasonCode: null,
  ownerSidSha256: shaC,
  currentUserSidSha256: shaC,
  inheritanceProtected: true,
  broadPrincipalEffectiveMask: 0,
  currentUserEffectiveMask: 1_048_575,
  secondUserReadSucceeded: false,
  secondUserWriteSucceeded: false,
  securityDescriptorSha256: shaD,
};

const f03Facts: ProbeF03Facts = {
  payloadKind: "port",
  targetTopology: "absent",
  operation: "create-private-file",
  operationApplied: true,
  win32Error: null,
  reasonCode: null,
  finalObjectType: "regular-file",
  finalObjectIdentitySha256: shaC,
  openedObjectIdentitySha256: shaC,
  linkCount: 1,
  reparseTag: 0,
  writtenPayloadSha256: shaD,
  readBackPayloadSha256: shaD,
  securityDescriptorSha256: shaE,
  ownerOnlyDacl: true,
  testedPayloadBytes: [128, 4096],
  outsideMutationCount: 0,
};

const f04Facts: ProbeF04Facts = {
  pathTopology: "concurrent-swap-loop",
  operation: "create",
  operationApplied: true,
  win32Error: null,
  reasonCode: null,
  openedRootIdentitySha256: shaC,
  finalRootIdentitySha256: shaC,
  outsideMutationCount: 0,
  reparseTraversalCount: 0,
  swapCount: 10_000,
  durationMs: 30_000,
  operationWorkerCount: 8,
  swapWorkerCount: 4,
  beforeTreeSha256: shaD,
  afterTreeSha256: shaE,
};

const f05Facts: ProbeF05Facts = {
  operation: "delete",
  identityClass: "same-object",
  lifetime: "same-process",
  operationApplied: true,
  win32Error: null,
  reasonCode: null,
  inspectedObjectIdentitySha256: shaC,
  currentObjectIdentitySha256: shaC,
  actedObjectIdentitySha256: shaC,
  unrelatedMutationCount: 0,
  identityCheckCount: 2,
  processRestartObserved: false,
  hardLinkAliasObserved: false,
};

const f06Facts: ProbeF06Facts = {
  context: "rapid-readers",
  checkpoint: "after-replace",
  shareMode: "share-allows-replace",
  replaceDisposition: "committed",
  win32Error: null,
  reasonCode: null,
  oldRecordSha256: shaC,
  candidateRecordSha256: shaD,
  observedRecordSha256s: [shaC, shaD],
  partialRecordCount: 0,
  missingRecordCount: 0,
  readerSampleCount: 32,
  remainingOwnedTempCount: 0,
  retryCount: 2,
  elapsedMs: 400,
  defenderScanObserved: false,
  processCrashObserved: false,
  rebootObserved: false,
};

const signedReceiptSha256s = ["1", "2", "3", "4", "5"].map((digit) => digit.repeat(64));

const f07Facts: ProbeF07Facts = {
  cutKind: "hard-cut",
  checkpoint: "parent-volume-flush",
  operationDisposition: "durably-committed",
  oldRecordSha256: shaC,
  candidateRecordSha256: shaD,
  recoveredRecordSha256s: [shaD],
  recoveredCompleteCount: 5,
  recoveredTornCount: 0,
  recoveredMissingCount: 0,
  fileFlushSupported: true,
  parentDirectoryFlushSupported: true,
  signedReceiptSha256s,
  verifiedReceiptSignatureCount: 5,
  verifiedReceiptBindingCount: 5,
  repetitionCount: 5,
  unprovableBoundaryObserved: false,
  checksumMismatchCount: 0,
};

const f08Facts: ProbeF08Facts = {
  primaryEndpointSha256: endpointNameSha256,
  comparisonEndpointSha256: shaE,
  independentEndpointSha256: endpointNameSha256,
  canonicalHomeInputSha256: shaC,
  endpointName,
  endpointSuffix,
  derivationDomain: "enduragent.windows-upgrade-fence.v1",
  appId: "icu.enduragent.desktop",
  processRole: "controller",
  endpointGrammarValid: true,
  rawIdentitySubstringPresent: false,
  connectionAccepted: true,
  authenticated: true,
  clientKind: null,
  clientDecision: null,
  win32Error: null,
  reasonCode: null,
  ownerSidSha256: shaD,
  standardUserSidSha256: shaD,
  firstInstanceHeld: true,
  maxConcurrentOwners: 1,
  ownershipSampleCount: 10_000,
  raceIterations: 1_000,
  ordinaryStarterCount: 20,
  crashReleased: true,
  admittedSuccessorCount: 1,
  observedFrameBytes: 128,
  connectElapsedMs: 25,
  readElapsedMs: 25,
  restartObserved: true,
  rebootObserved: true,
  handoffCheckpoint: null,
  collisionInjected: false,
  collisionRefused: false,
  neitherWindowCount: 0,
};

const f09Facts: ProbeF09Facts = {
  processCreatedSuspended: true,
  jobAssignedBeforeResume: true,
  mainPid: 90401,
  mainCreationTimeSha256: shaC,
  observedCreationTimeSha256: shaC,
  descendantCount: 3,
  survivingDescendantCount: 0,
  unrelatedProcessSurvived: true,
  gracefulStopElapsedMs: 250,
  forcedStopElapsedMs: 500,
  readyObserved: true,
  shutdownAcknowledged: true,
  forcedTerminationUsed: false,
  outerJobPresent: false,
  breakawayAllowed: false,
  nestedAssignmentSucceeded: false,
  win32Error: null,
  reasonCode: null,
  pidPressureCount: 20_000,
  pidReuseMisbindCount: 0,
  osShutdownNotificationObserved: true,
  startFrameSent: false,
  mainProcessCrashObserved: true,
  daemonCrashAfterReadyObserved: true,
  grandchildSpawned: true,
  hangBeforeReadyObserved: true,
  normalReadyShutdownObserved: true,
  explicitQuitObserved: true,
  uninstallDrainObserved: true,
  updateDrainObserved: true,
  unrelatedSafetyProbeObserved: true,
};

const f10Facts: ProbeF10Facts = {
  starterCount: 32,
  raceRounds: 100,
  successfulWriterCount: 1,
  simultaneousWriterMax: 1,
  databaseWriterCount: 1,
  portOwnerCount: 1,
  homeIdentitySha256: shaC,
  comparisonHomeIdentitySha256: shaD,
  listenerAuthenticated: true,
  listenerCompatible: true,
  listenerResponsive: true,
  starterAdmitted: false,
  win32Error: null,
  reasonCode: null,
  staleLockReclaimed: true,
  stalePortFileReclaimed: true,
  readOnlyMutationCount: 0,
  secondUserAccessSucceeded: false,
  pidCreationMatches: true,
  retryCount: 2,
  elapsedMs: 400,
  defenderShareDenyObserved: true,
  crashCheckpointReached: true,
  crashCheckpoint: "after-port-bind",
  recoveryWriterCount: 1,
  protocolRelation: "compatible",
  unmanagedPeerGuidanceEmitted: true,
  healthyPeerObserved: true,
  foreignListenerObserved: true,
  unresponsiveListenerObserved: true,
  databaseSentinelObserved: true,
  distinctHomeControlObserved: true,
  staleLockIdentityProved: true,
  stalePortIdentityProved: true,
  readOnlyToolingObserved: true,
  secondElectronActivationObserved: true,
  activationRoutedToExistingInstance: true,
  secondUserProbeObserved: true,
  pidReusePressureObserved: true,
  unmanagedPeerObserved: true,
  mixedAliasRaceObserved: true,
  simultaneousElectronLaunchObserved: true,
};

function verify(rowId: string, variantId: string, facts: ProbeRawFactEnvelope<ProbeRowFacts>) {
  return verifyProbeFacts({
    rowId,
    variantId,
    rawFacts: facts,
    artifactHashes: artifactHashesFor(facts),
    verifierSourceSha256: sourceSha256,
  });
}

describe("Windows host probe verifier registry", () => {
  it("defines exactly one strict verifier for every frozen F-01 through F-10 variant", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("./fixtures/windows-host/probe-campaign.json", import.meta.url),
        "utf8",
      ),
    ) as ProbeCampaignManifest;
    const expected = manifest.rows
      .flatMap((row) => [
        ...row.requiredVariantIds.map((variantId) => `${row.rowId}\0${variantId}`),
        ...row.conditionalVariants.map((variant) => `${row.rowId}\0${variant.variantId}`),
      ])
      .sort();
    const actual = PROBE_VERIFIER_DEFINITIONS.map(
      (definition) => `${definition.rowId}\0${definition.variantId}`,
    ).sort();

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    expect(
      [
        ...new Set(
          PROBE_VERIFIER_DEFINITIONS.filter((entry) => entry.rowId === "F-07").map(
            (entry) => entry.verifierId,
          ),
        ),
      ].sort(),
    ).toEqual(["hard-cut-probe-verifier-v1", "native-probe-verifier-v1"]);
    expect(
      PROBE_VERIFIER_DEFINITIONS.every((definition) =>
        definition.definitionSha256.match(/^[a-f0-9]{64}$/u),
      ),
    ).toBe(true);
  });

  it("exports an immutable variant-specific command-to-fact mapping from the verifier authority", () => {
    const cases: readonly [string, string, ProbeRowFacts][] = [
      ["F-01", "f01-actual-component-case-alias", f01Facts],
      ["F-02", "f02-create-private-directory", f02Facts],
      ["F-03", "f03-port-absent", f03Facts],
      ["F-04", "f04-concurrent-swap-loop-create", f04Facts],
      ["F-05", "f05-delete-same-object-same-process", f05Facts],
      ["F-06", "f06-rapid-readers-after-replace-share-allows-replace", f06Facts],
      ["F-07", "f07-hard-cut-after-parent-volume-flush", f07Facts],
      ["F-08", "f08-starter-race", f08Facts],
      ["F-09", "f09-assignment-before-start", f09Facts],
      ["F-10", "f10-simultaneous-electron-launches", f10Facts],
    ];
    const compareUtf8 = (left: string, right: string) =>
      Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));

    expect(PROBE_TRANSCRIPT_FACT_DEFINITIONS).toHaveLength(PROBE_VERIFIER_DEFINITIONS.length);
    for (const [rowId, variantId, facts] of cases) {
      const definition = getProbeVerifierDefinition(rowId, variantId);
      const mapping = getProbeTranscriptFactDefinition(rowId, variantId);
      const mappedFactKeys = mapping.commands
        .flatMap((command) => command.factKeys)
        .sort(compareUtf8);
      const expectedFactKeys = Object.keys(facts).sort(compareUtf8);

      expect(mapping).toMatchObject({
        schemaVersion: 1,
        kind: "windows-host-probe-transcript-fact-definition",
        rowId,
        variantId,
        definitionSha256: definition.definitionSha256,
        rawFactSchemaId: definition.rawFactSchemaId,
        transcriptKind: definition.transcriptKind,
      });
      expect(mapping.commands.map((command) => command.commandId)).toEqual(
        definition.transcriptCommandIds,
      );
      expect(mappedFactKeys).toEqual(expectedFactKeys);
      expect(new Set(mappedFactKeys).size).toBe(mappedFactKeys.length);
      for (const command of mapping.commands) {
        expect(command.factKeys).toEqual([...command.factKeys].sort(compareUtf8));
      }
      expect(mapping.mappingSha256).toMatch(/^[a-f0-9]{64}$/u);
      const { mappingSha256: _mappingSha256, ...mappingPayload } = mapping;
      expect(mapping.mappingSha256).toBe(
        hashProbeCanonicalJson({
          domain: "enduragent.windows-host-probe-transcript-fact-definition.v1",
          definition: mappingPayload,
        }),
      );
      expect(getProbeTranscriptFactDefinition(rowId, variantId)).toBe(mapping);
      expect(Object.isFrozen(mapping)).toBe(true);
      expect(Object.isFrozen(mapping.commands)).toBe(true);
      expect(mapping.commands.every((command) => Object.isFrozen(command.factKeys))).toBe(true);
    }

    const ordinary = getProbeTranscriptFactDefinition("F-01", "f01-ordinary-absolute-path");
    const restart = getProbeTranscriptFactDefinition("F-01", "f01-restart-stability");
    expect(restart.variantId).not.toBe(ordinary.variantId);
    expect(restart.definitionSha256).not.toBe(ordinary.definitionSha256);
    expect(restart.mappingSha256).not.toBe(ordinary.mappingSha256);
    expect(() => getProbeTranscriptFactDefinition("F-01", "f01-invented")).toThrow(
      /no allowlisted verifier/u,
    );

    const ownedFactKeys = (rowId: string, variantId: string, commandId: string) =>
      getProbeTranscriptFactDefinition(rowId, variantId).commands.find(
        (command) => command.commandId === commandId,
      )?.factKeys;
    expect(
      ownedFactKeys("F-02", "f02-create-private-directory", "private-directory-ensure"),
    ).toEqual(expect.arrayContaining(["rootClass", "operationApplied", "reasonCode"]));
    expect(
      ownedFactKeys("F-02", "f02-create-private-directory", "private-directory-inspect"),
    ).toEqual(expect.arrayContaining(["ownerSidSha256", "securityDescriptorSha256"]));
    expect(ownedFactKeys("F-03", "f03-port-absent", "file-identity")).toContain(
      "finalObjectIdentitySha256",
    );
    expect(ownedFactKeys("F-03", "f03-port-absent", "private-file-create")).toContain(
      "writtenPayloadSha256",
    );
    expect(
      ownedFactKeys("F-04", "f04-concurrent-swap-loop-create", "evidence-tree-seal"),
    ).toContain("beforeTreeSha256");
    expect(
      ownedFactKeys("F-04", "f04-concurrent-swap-loop-create", "secure-path-operation"),
    ).toContain("durationMs");
    expect(ownedFactKeys("F-05", "f05-delete-same-object-same-process", "file-identity")).toContain(
      "inspectedObjectIdentitySha256",
    );
    expect(
      ownedFactKeys("F-05", "f05-delete-same-object-same-process", "secure-path-operation"),
    ).toContain("actedObjectIdentitySha256");
  });

  it("derives PASS and the mechanism from complete primitive facts for every row", () => {
    const cases: [string, string, ProbeRawFactEnvelope<ProbeRowFacts>][] = [
      [
        "F-01",
        "f01-actual-component-case-alias",
        rawFacts("F-01", "f01-actual-component-case-alias", f01Facts),
      ],
      [
        "F-02",
        "f02-create-private-directory",
        rawFacts("F-02", "f02-create-private-directory", f02Facts),
      ],
      ["F-03", "f03-port-absent", rawFacts("F-03", "f03-port-absent", f03Facts)],
      [
        "F-04",
        "f04-concurrent-swap-loop-create",
        rawFacts("F-04", "f04-concurrent-swap-loop-create", f04Facts),
      ],
      [
        "F-05",
        "f05-delete-same-object-same-process",
        rawFacts("F-05", "f05-delete-same-object-same-process", f05Facts),
      ],
      [
        "F-06",
        "f06-rapid-readers-after-replace-share-allows-replace",
        rawFacts("F-06", "f06-rapid-readers-after-replace-share-allows-replace", f06Facts),
      ],
      [
        "F-07",
        "f07-hard-cut-after-parent-volume-flush",
        rawFacts("F-07", "f07-hard-cut-after-parent-volume-flush", f07Facts),
      ],
      ["F-08", "f08-starter-race", rawFacts("F-08", "f08-starter-race", f08Facts)],
      [
        "F-09",
        "f09-assignment-before-start",
        rawFacts("F-09", "f09-assignment-before-start", f09Facts),
      ],
      [
        "F-10",
        "f10-simultaneous-electron-launches",
        rawFacts("F-10", "f10-simultaneous-electron-launches", f10Facts),
      ],
    ];

    for (const [rowId, variantId, facts] of cases) {
      const result = verify(rowId, variantId, facts);
      const definition = getProbeVerifierDefinition(rowId, variantId);
      expect(result.outcome, `${rowId}/${variantId}`).toBe("PASS");
      expect(result.mechanismId).toBe(definition.mechanismId);
      expect(result.mechanismDefinition).toEqual(definition.mechanismDefinition);
      expect(result.verifierId).toBe(definition.verifierId);
      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.verificationMetrics).toContainEqual({
        name: "failed-check-count",
        unit: "count",
        value: 0,
      });
      expect(result.verifierInputSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("requires the named F-01 and F-08 scenario semantics, not a shared happy-path fact set", () => {
    const ineligibleStorage = verify(
      "F-01",
      "f01-ordinary-absolute-path",
      rawFacts("F-01", "f01-ordinary-absolute-path", {
        ...f01Facts,
        volumeFileSystem: "exFAT",
      }),
    );
    expect(ineligibleStorage.outcome).toBe("FAIL");

    const goldenSuffix = "ae2b85ba30dee3e6422838e25c209a38d3d8f45b0dcff2e3753fa72181427736";
    const goldenName = `\\\\.\\pipe\\Enduragent-upgrade-v1-${goldenSuffix}`;
    const goldenNameSha256 = createHash("sha256").update(goldenName, "utf8").digest("hex");
    const goldenFacts: ProbeF08Facts = {
      ...f08Facts,
      primaryEndpointSha256: goldenNameSha256,
      independentEndpointSha256: goldenNameSha256,
      endpointName: goldenName,
      endpointSuffix: goldenSuffix,
      processRole: "main",
    };
    expect(
      verify(
        "F-08",
        "f08-main-golden-home-a",
        rawFacts("F-08", "f08-main-golden-home-a", goldenFacts),
      ).outcome,
    ).toBe("PASS");
    expect(
      verify(
        "F-08",
        "f08-main-golden-home-a",
        rawFacts("F-08", "f08-main-golden-home-a", {
          ...f08Facts,
          processRole: "main",
        }),
      ).outcome,
    ).toBe("FAIL");

    const correctCheckpoint = {
      ...f08Facts,
      handoffCheckpoint: "before-accept" as const,
    };
    expect(
      verify(
        "F-08",
        "f08-kill-before-accept",
        rawFacts("F-08", "f08-kill-before-accept", correctCheckpoint),
      ).outcome,
    ).toBe("PASS");
    expect(
      verify(
        "F-08",
        "f08-kill-before-accept",
        rawFacts("F-08", "f08-kill-before-accept", {
          ...correctCheckpoint,
          handoffCheckpoint: "during-frame-read",
        }),
      ).outcome,
    ).toBe("FAIL");
  });

  it("rejects cross-variant fact relabeling for every grouped F-01 through F-07 family", () => {
    const relabeledCases: [string, string, ProbeRowFacts][] = [
      [
        "F-01",
        "f01-reboot-stability",
        {
          ...f01Facts,
          pathTopology: "ordinary-absolute-path",
          lifecycle: "restart",
        },
      ],
      [
        "F-02",
        "f02-invalid-root-relative",
        {
          ...f02Facts,
          rootClass: "invalid-network",
          operation: "validate-root",
          operationApplied: false,
          reasonCode: "UNSUPPORTED_STORAGE",
        },
      ],
      [
        "F-03",
        "f03-port-hard-link",
        {
          ...f03Facts,
          targetTopology: "directory",
          operationApplied: false,
          finalObjectType: "directory",
          reasonCode: "UNEXPECTED_OBJECT",
        },
      ],
      [
        "F-04",
        "f04-leaf-symlink-delete",
        {
          ...f04Facts,
          pathTopology: "ancestor-junction",
          operation: "create",
          operationApplied: false,
          reasonCode: "REPARSE_POINT",
        },
      ],
      ["F-05", "f05-quarantine-same-object-same-process", f05Facts],
      ["F-06", "f06-baseline-after-replace-share-allows-replace", f06Facts],
      ["F-07", "f07-process-kill-after-parent-volume-flush", f07Facts],
    ];

    for (const [rowId, variantId, facts] of relabeledCases) {
      expect(
        verify(rowId, variantId, rawFacts(rowId, variantId, facts)).outcome,
        `${rowId}/${variantId}`,
      ).toBe("FAIL");
    }
  });

  it("binds primitive facts to an allowlisted typed native or controller transcript", () => {
    const bound = rawFacts("F-01", "f01-actual-component-case-alias", f01Facts);
    expect(verify("F-01", "f01-actual-component-case-alias", bound).outcome).toBe("PASS");

    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...bound,
        facts: { ...f01Facts, comparisonIdentitySha256: shaD },
      }),
    ).toThrow(/factsSha256 does not bind/u);
    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...bound,
        captureComplete: false,
      }),
    ).toThrow(/captureSha256 does not bind/u);
    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...bound,
        scenario: {
          ...bound.scenario,
          transcript: {
            ...bound.scenario.transcript,
            commandIds: ["file-identity"],
          },
        },
      }),
    ).toThrow(/commandIds do not match/u);
    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...bound,
        scenario: {
          ...bound.scenario,
          transcript: {
            ...bound.scenario.transcript,
            kind: "windows-host-probe-controller-transcript",
          },
        },
      } as ProbeRawFactEnvelope<ProbeRowFacts>),
    ).toThrow(/schemaVersion\/kind does not match/u);
    expect(() =>
      verifyProbeFacts({
        rowId: "F-01",
        variantId: "f01-actual-component-case-alias",
        rawFacts: bound,
        artifactHashes: [{ path: PROBE_VERIFIER_SOURCE_PATH, sha256: sourceSha256 }],
        verifierSourceSha256: sourceSha256,
      }),
    ).toThrow(/retain evidence separate from the verifier source/u);

    const hardCut = getProbeVerifierDefinition("F-07", "f07-hard-cut-after-parent-volume-flush");
    expect(hardCut.transcriptKind).toBe("windows-host-probe-controller-transcript");
    expect(getProbeVerifierDefinition("F-03", "f03-port-absent").transcriptKind).toBe(
      "windows-host-probe-native-transcript",
    );
  });

  it("requires named F-09 lifecycle and identity observations", () => {
    expect(
      verify(
        "F-09",
        "f09-normal-ready-shutdown",
        rawFacts("F-09", "f09-normal-ready-shutdown", f09Facts),
      ).outcome,
    ).toBe("PASS");
    expect(
      verify(
        "F-09",
        "f09-normal-ready-shutdown",
        rawFacts("F-09", "f09-normal-ready-shutdown", {
          ...f09Facts,
          normalReadyShutdownObserved: false,
        }),
      ).outcome,
    ).toBe("FAIL");

    expect(
      verify(
        "F-09",
        "f09-pid-creation-time-binding",
        rawFacts("F-09", "f09-pid-creation-time-binding", f09Facts),
      ).outcome,
    ).toBe("PASS");
    expect(
      verify(
        "F-09",
        "f09-pid-creation-time-binding",
        rawFacts("F-09", "f09-pid-creation-time-binding", {
          ...f09Facts,
          mainPid: null,
        }),
      ).outcome,
    ).toBe("INCONCLUSIVE");
  });

  it("distinguishes F-10 peer classes and second-activation behavior", () => {
    const foreignFacts: ProbeF10Facts = {
      ...f10Facts,
      foreignListenerObserved: true,
      listenerAuthenticated: false,
      starterAdmitted: false,
      win32Error: 5,
    };
    expect(
      verify("F-10", "f10-foreign-listener", rawFacts("F-10", "f10-foreign-listener", foreignFacts))
        .outcome,
    ).toBe("PASS");
    expect(
      verify(
        "F-10",
        "f10-foreign-listener",
        rawFacts("F-10", "f10-foreign-listener", {
          ...foreignFacts,
          foreignListenerObserved: false,
          unresponsiveListenerObserved: true,
        }),
      ).outcome,
    ).toBe("FAIL");

    expect(
      verify(
        "F-10",
        "f10-second-electron-activation",
        rawFacts("F-10", "f10-second-electron-activation", f10Facts),
      ).outcome,
    ).toBe("PASS");
    expect(
      verify(
        "F-10",
        "f10-second-electron-activation",
        rawFacts("F-10", "f10-second-electron-activation", {
          ...f10Facts,
          activationRoutedToExistingInstance: false,
        }),
      ).outcome,
    ).toBe("FAIL");
  });

  it("accepts allowlisted semantic refusal reasons without inventing Win32 codes", () => {
    const reparseRefusal: ProbeF04Facts = {
      ...f04Facts,
      pathTopology: "ancestor-junction",
      operationApplied: false,
      win32Error: null,
      reasonCode: "REPARSE_POINT",
    };
    expect(
      verify(
        "F-04",
        "f04-ancestor-junction-create",
        rawFacts("F-04", "f04-ancestor-junction-create", reparseRefusal),
      ).outcome,
    ).toBe("PASS");

    const identityRefusal: ProbeF05Facts = {
      ...f05Facts,
      identityClass: "stale-identity",
      operationApplied: false,
      currentObjectIdentitySha256: shaD,
      actedObjectIdentitySha256: null,
      win32Error: null,
      reasonCode: "IDENTITY_MISMATCH",
    };
    expect(
      verify(
        "F-05",
        "f05-delete-stale-identity-same-process",
        rawFacts("F-05", "f05-delete-stale-identity-same-process", identityRefusal),
      ).outcome,
    ).toBe("PASS");
    expect(
      verify(
        "F-05",
        "f05-delete-stale-identity-same-process",
        rawFacts("F-05", "f05-delete-stale-identity-same-process", {
          ...identityRefusal,
          reasonCode: "REPARSE_POINT",
        }),
      ).outcome,
    ).toBe("FAIL");
  });

  it("derives conditional SKIP only from captured unavailability", () => {
    const result = verify(
      "F-01",
      "f01-8dot3-short-name-alias",
      rawFacts("F-01", "f01-8dot3-short-name-alias", f01Facts, {
        availability: {
          status: "unavailable",
          reason: "The volume capability query reports that short names are disabled.",
        },
      }),
    );

    expect(result.outcome).toBe("SKIP");
    expect(result.unavailability).toEqual({
      conditionId: "8dot3-names-enabled",
      observedUnavailable: true,
      reason: "The volume capability query reports that short names are disabled.",
    });

    const incomplete = verify(
      "F-01",
      "f01-8dot3-short-name-alias",
      rawFacts("F-01", "f01-8dot3-short-name-alias", f01Facts, {
        captureComplete: false,
        availability: { status: "unavailable", reason: "Capability query was interrupted." },
      }),
    );
    expect(incomplete.outcome).toBe("INCONCLUSIVE");
    expect(incomplete.unavailability).toBeNull();

    const required = verify(
      "F-01",
      "f01-ordinary-absolute-path",
      rawFacts("F-01", "f01-ordinary-absolute-path", f01Facts, {
        availability: { status: "unavailable", reason: "Required host primitive was absent." },
      }),
    );
    expect(required.outcome).toBe("INCONCLUSIVE");
  });

  it("rejects caller-authored outcome, mechanism, and verifier authority", () => {
    const inputRawFacts = rawFacts("F-01", "f01-actual-component-case-alias", f01Facts);
    const input = {
      rowId: "F-01",
      variantId: "f01-actual-component-case-alias",
      rawFacts: inputRawFacts,
      artifactHashes: artifactHashesFor(inputRawFacts),
      verifierSourceSha256: sourceSha256,
    };

    expect(() =>
      verifyProbeFacts({ ...input, outcome: "PASS" } as unknown as Parameters<
        typeof verifyProbeFacts
      >[0]),
    ).toThrow(/unexpected key: outcome/u);
    expect(() =>
      verifyProbeFacts({
        ...input,
        mechanismId: "caller-selected-mechanism",
      } as unknown as Parameters<typeof verifyProbeFacts>[0]),
    ).toThrow(/unexpected key: mechanismId/u);
    expect(() =>
      verifyProbeFacts({ ...input, verifierId: "unknown-verifier-v1" } as unknown as Parameters<
        typeof verifyProbeFacts
      >[0]),
    ).toThrow(/unexpected key: verifierId/u);
  });

  it("rejects unknown coordinates and strict-schema drift", () => {
    expect(() => getProbeVerifierDefinition("F-11", "f11-invented")).toThrow(
      /no allowlisted verifier/u,
    );
    expect(() => getProbeVerifierDefinition("F-01", "f01-invented")).toThrow(
      /no allowlisted verifier/u,
    );

    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...rawFacts("F-01", "f01-actual-component-case-alias", f01Facts),
        facts: { ...f01Facts, callerVerdict: true },
      } as unknown as ProbeRawFactEnvelope<ProbeRowFacts>),
    ).toThrow(/unexpected key: callerVerdict/u);

    const { localPathSha256: _removed, ...missingFact } = f01Facts;
    expect(() =>
      verify(
        "F-01",
        "f01-actual-component-case-alias",
        rawFacts(
          "F-01",
          "f01-actual-component-case-alias",
          missingFact as unknown as ProbeF01Facts,
        ),
      ),
    ).toThrow(/missing key: localPathSha256/u);

    expect(() =>
      verify(
        "F-01",
        "f01-actual-component-case-alias",
        rawFacts("F-01", "f01-actual-component-case-alias", f02Facts as unknown as ProbeF01Facts),
      ),
    ).toThrow(/rawFacts\.facts has unexpected key/u);

    const bound = rawFacts("F-01", "f01-actual-component-case-alias", f01Facts);
    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...bound,
        scenario: { ...bound.scenario, variantId: "f01-restart-stability" },
      }),
    ).toThrow(/scenario\.variantId does not match/u);
    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...bound,
        scenario: { ...bound.scenario, definitionSha256: "f".repeat(64) },
      }),
    ).toThrow(/does not match the allowlisted verifier definition/u);
    expect(() =>
      verify("F-01", "f01-actual-component-case-alias", {
        ...bound,
        scenario: { ...bound.scenario, evidenceSha256: "f".repeat(64) },
      }),
    ).toThrow(/does not identify the retained source transcript/u);
  });

  it("binds source, artifact, definition, and raw-fact tampering into canonical digests", () => {
    const baselineRawFacts = rawFacts("F-01", "f01-actual-component-case-alias", f01Facts);
    const baseline = verify("F-01", "f01-actual-component-case-alias", baselineRawFacts);
    const changedArtifactHashes = artifactHashesFor(baselineRawFacts, [
      { path: "evidence/unrelated.json", sha256: "f".repeat(64) },
    ]);
    const changedArtifact = verifyProbeFacts({
      rowId: "F-01",
      variantId: "f01-actual-component-case-alias",
      rawFacts: baselineRawFacts,
      artifactHashes: changedArtifactHashes,
      verifierSourceSha256: sourceSha256,
    });
    const changedFacts = verify(
      "F-01",
      "f01-actual-component-case-alias",
      rawFacts("F-01", "f01-actual-component-case-alias", {
        ...f01Facts,
        comparisonIdentitySha256: shaD,
      }),
    );

    expect(changedArtifact.verifierInputSha256).not.toBe(baseline.verifierInputSha256);
    expect(changedArtifact.rawFactsSha256).toBe(baseline.rawFactsSha256);
    expect(changedFacts.verifierInputSha256).not.toBe(baseline.verifierInputSha256);
    expect(changedFacts.rawFactsSha256).not.toBe(baseline.rawFactsSha256);
    expect(changedFacts.outcome).toBe("FAIL");

    const sourceMismatchRawFacts = rawFacts("F-01", "f01-actual-component-case-alias", f01Facts);
    expect(() =>
      verifyProbeFacts({
        rowId: "F-01",
        variantId: "f01-actual-component-case-alias",
        rawFacts: sourceMismatchRawFacts,
        artifactHashes: artifactHashesFor(sourceMismatchRawFacts),
        verifierSourceSha256: "f".repeat(64),
      }),
    ).toThrow(/must identify a retained artifact hash/u);
  });

  it("derives FAIL ahead of INCONCLUSIVE and never passes missing hard-cut receipts", () => {
    const violated = verify(
      "F-04",
      "f04-concurrent-swap-loop-create",
      rawFacts(
        "F-04",
        "f04-concurrent-swap-loop-create",
        { ...f04Facts, outsideMutationCount: 1, durationMs: null },
        { captureComplete: false },
      ),
    );
    expect(violated.outcome).toBe("FAIL");
    expect(violated.verificationMetrics).toContainEqual({
      name: "failed-check-count",
      unit: "count",
      value: 1,
    });

    const missingReceipts = verify(
      "F-07",
      "f07-hard-cut-after-parent-volume-flush",
      rawFacts("F-07", "f07-hard-cut-after-parent-volume-flush", {
        ...f07Facts,
        signedReceiptSha256s: [],
        verifiedReceiptSignatureCount: 0,
        verifiedReceiptBindingCount: 0,
      }),
    );
    expect(missingReceipts.outcome).toBe("INCONCLUSIVE");
    expect(missingReceipts.verificationMetrics).toContainEqual({
      name: "unknown-check-count",
      unit: "count",
      value: 3,
    });

    const badSignature = verify(
      "F-07",
      "f07-hard-cut-after-parent-volume-flush",
      rawFacts("F-07", "f07-hard-cut-after-parent-volume-flush", {
        ...f07Facts,
        verifiedReceiptSignatureCount: 4,
      }),
    );
    expect(badSignature.outcome).toBe("FAIL");
  });

  it("is deterministic across object insertion order and deeply freezes derived authority", () => {
    const forward = verify(
      "F-02",
      "f02-create-private-directory",
      rawFacts("F-02", "f02-create-private-directory", f02Facts),
    );
    const reverseFacts = Object.fromEntries(
      Object.entries(f02Facts).reverse(),
    ) as unknown as ProbeF02Facts;
    const reverseRaw = {
      facts: reverseFacts,
      availability: { reason: null, status: "available" },
      scenario: rawFacts("F-02", "f02-create-private-directory", f02Facts).scenario,
      captureComplete: true,
      kind: "windows-host-probe-raw-facts",
      schemaVersion: 1,
    } as const;
    const reversed = verifyProbeFacts({
      verifierSourceSha256: sourceSha256,
      artifactHashes: artifactHashesFor(reverseRaw),
      rawFacts: reverseRaw,
      variantId: "f02-create-private-directory",
      rowId: "F-02",
    });

    expect(reversed).toEqual(forward);
    expect(Object.isFrozen(reversed)).toBe(true);
    expect(Object.isFrozen(reversed.observations)).toBe(true);
    expect(Object.isFrozen(reversed.mechanismDefinition)).toBe(true);
    expect(
      Object.isFrozen(getProbeVerifierDefinition("F-02", "f02-create-private-directory")),
    ).toBe(true);
  });
});
