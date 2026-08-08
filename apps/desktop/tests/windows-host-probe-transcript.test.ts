import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { createProbeControllerActionAttestation } from "../scripts/windows-host-falsifier/probe-controller-action-provenance.mjs";
import { getProbeVerifierDefinition } from "../scripts/windows-host-falsifier/probe-registry.mjs";
import {
  ProbeTranscriptError,
  deriveControllerSourceTranscriptReceiptDigest,
  reduceProbeSourceTranscript,
  type ProbeControllerSourceTranscriptReceipt,
  type ProbeNativeTranscriptIdentity,
  type ProbeTrustedNativeTranscriptEvidence,
  type ProbeSourceTranscript,
  type ProbeSourceTranscriptBinding,
  type ProbeTranscriptFactValue,
  type ProbeTranscriptObservation,
  type ProbeTranscriptProducer,
  type ProbeTranscriptControllerIdentity,
  type TrustedProbeTranscriptDefinition,
} from "../scripts/windows-host-falsifier/probe-transcript.mjs";

const digest = (character: string) => character.repeat(64);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const compactCanonicalDigest = (value: unknown) =>
  sha256(Buffer.from(JSON.stringify(JSON.parse(canonicalProbeJson(value))), "utf8"));
const utf8Sort = (values: readonly string[]) =>
  [...values].sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));

const verifier = getProbeVerifierDefinition("F-01", "f01-ordinary-absolute-path");
const f01FactKeys = utf8Sort([
  "pathTopology",
  "processRole",
  "lifecycle",
  "credentialReadAttempted",
  "canonicalIdentitySha256",
  "comparisonIdentitySha256",
  "localPathSha256",
  "volumeIdentitySha256",
  "volumeFileSystem",
  "volumeDriveType",
  "win32Error",
  "reasonCode",
]);

const nativeRunRootIdentity = "volume-1:file-101";
const nativeRunRootIdentitySha256 = createHash("sha256")
  .update(nativeRunRootIdentity, "utf8")
  .digest("hex");

const binding: ProbeSourceTranscriptBinding = {
  campaignId: "f01-f10-native-probe-v1",
  manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
  candidateSha256: digest("b"),
  labAttestationSha256: digest("c"),
  campaignRunId: "campaign-run-01",
  executionRunId: "execution-run-01",
  executionBundleId: "execution-bundle-01",
  executionBundleManifestSha256: digest("d"),
  attemptId: "attempt-01",
  preflightSha256: digest("e"),
  preparationScopeSha256: digest("f"),
  environmentId: "win11-current",
  pathProfileId: "ascii",
  vmSnapshotId: "snapshot-01",
  bootIdSha256: digest("0"),
  runnerSessionIdSha256: digest("1"),
  rootPathSha256: digest("2"),
  evidenceRootObjectIdentitySha256: nativeRunRootIdentitySha256,
  volumeIdSha256: digest("4"),
  rowId: verifier.rowId,
  variantId: verifier.variantId,
  verifierDefinitionSha256: verifier.definitionSha256,
  verifierSourceSha256: digest("5"),
};

const producer: ProbeTranscriptProducer = {
  kind: "native-helper",
  identitySha256: digest("6"),
};

const nativeBindingFields = {
  campaignRunId: binding.campaignRunId,
  candidateSha256: binding.candidateSha256,
  preflightSha256: binding.preflightSha256,
  executionBundleManifestSha256: binding.executionBundleManifestSha256,
  nativeHelperArtifactPath: "campaign/binaries/windows-host-falsifier.exe",
  nativeHelperSha256: producer.identitySha256,
  evidenceRootObjectIdentitySha256: nativeRunRootIdentitySha256,
  nativeCandidateDigest: digest("8"),
  nativeManifestSha256: digest("9"),
  nativeSessionId: "native-0001",
  runRootIdentity: nativeRunRootIdentity,
} as const;
const startupRequestId = "startup-request-0001";
function createStartupHandshake(
  nativeBinding: Omit<
    ProbeNativeTranscriptIdentity["binding"],
    "startupHandshake" | "startupHandshakeSha256"
  >,
) {
  const requestContext = {
    campaignRunId: nativeBinding.campaignRunId,
    candidateSha256: nativeBinding.candidateSha256,
    preflightSha256: nativeBinding.preflightSha256,
    executionBundleManifestSha256: nativeBinding.executionBundleManifestSha256,
    nativeCandidateDigest: nativeBinding.nativeCandidateDigest,
    nativeManifestSha256: nativeBinding.nativeManifestSha256,
    nativeHelperSha256: nativeBinding.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: nativeBinding.evidenceRootObjectIdentitySha256,
    nativeSessionId: nativeBinding.nativeSessionId,
    operationId: "startup-0001",
  } as const;
  return {
    protocolVersion: 1,
    kind: "response",
    requestId: startupRequestId,
    command: "native-binding-check",
    context: {
      ...requestContext,
      requestFrameSha256: compactCanonicalDigest({
        protocolVersion: 1,
        requestId: startupRequestId,
        command: "native-binding-check",
        context: requestContext,
        request: {},
      }),
      runRootIdentity: nativeBinding.runRootIdentity,
    },
    ok: true,
    result: {
      ready: true,
      processId: 1234,
      nativeHelperSha256: nativeBinding.nativeHelperSha256,
      runRootIdentity: nativeBinding.runRootIdentity,
      evidenceRootObjectIdentitySha256: nativeBinding.evidenceRootObjectIdentitySha256,
    },
  } as const;
}
const startupHandshake = createStartupHandshake(nativeBindingFields);

const nativeTranscripts: readonly ProbeNativeTranscriptIdentity[] = [
  {
    transcriptSha256: digest("7"),
    binding: {
      ...nativeBindingFields,
      startupHandshake,
      startupHandshakeSha256: compactCanonicalDigest(startupHandshake),
    },
  },
];

const trustedNativeTranscripts: readonly ProbeTrustedNativeTranscriptEvidence[] = [
  {
    ...nativeTranscripts[0],
    commandRecords: [
      {
        command: "home-identity",
        requestFrameSha256: digest("e"),
        responseFrameSha256: digest("f"),
        ok: true,
      },
    ],
  },
];

const observerBindingFields = {
  ...nativeBindingFields,
  nativeSessionId: "native-0002",
} as const;
const observerStartupHandshake = createStartupHandshake(observerBindingFields);
const observerNativeTranscript: ProbeTrustedNativeTranscriptEvidence = {
  transcriptSha256: digest("a"),
  binding: {
    ...observerBindingFields,
    startupHandshake: observerStartupHandshake,
    startupHandshakeSha256: compactCanonicalDigest(observerStartupHandshake),
  },
  commandRecords: [
    {
      command: "private-directory-inspect",
      requestFrameSha256: digest("1"),
      responseFrameSha256: digest("2"),
      ok: true,
    },
  ],
};

const controllerKeyPair = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeyPair.publicKey.export({
  type: "spki",
  format: "der",
});
const expectedController: ProbeTranscriptControllerIdentity = {
  identitySha256: digest("0"),
  publicKeySha256: sha256(controllerPublicKeyBytes),
  version: "v1.0.0",
};

const trustedDefinition: TrustedProbeTranscriptDefinition = {
  rowId: verifier.rowId,
  variantId: verifier.variantId,
  definitionSha256: verifier.definitionSha256,
  verifierSourceSha256: binding.verifierSourceSha256,
  transcriptKind: verifier.transcriptKind,
  commands: [
    {
      commandId: verifier.transcriptCommandIds[0],
      factKeys: f01FactKeys,
    },
  ],
};

const factValues: Readonly<Record<string, ProbeTranscriptFactValue>> = {
  pathTopology: "ordinary-absolute-path",
  processRole: "main",
  lifecycle: "same-process",
  credentialReadAttempted: false,
  canonicalIdentitySha256: digest("b"),
  comparisonIdentitySha256: digest("b"),
  localPathSha256: digest("c"),
  volumeIdentitySha256: digest("d"),
  volumeFileSystem: "NTFS",
  volumeDriveType: "fixed",
  win32Error: null,
  reasonCode: null,
};

function observationFrom(
  values: Readonly<Record<string, ProbeTranscriptFactValue>>,
  factKey: string,
): ProbeTranscriptObservation {
  const value = values[factKey];
  if (value === null) return { factKey, valueKind: "null", value };
  if (Array.isArray(value)) {
    const first = value[0];
    const elementType = typeof first;
    if (elementType === "boolean") return { factKey, valueKind: "boolean-array", value };
    if (elementType === "number") return { factKey, valueKind: "number-array", value };
    return { factKey, valueKind: "string-array", value };
  }
  if (typeof value === "boolean") return { factKey, valueKind: "boolean", value };
  if (typeof value === "number") return { factKey, valueKind: "number", value };
  return { factKey, valueKind: "string", value };
}

const observation = (factKey: string) => observationFrom(factValues, factKey);

const sourceTranscript: ProbeSourceTranscript = {
  schemaVersion: 1,
  kind: "windows-host-probe-source-transcript",
  producer,
  binding,
  nativeTranscripts,
  observerNativeTranscriptSha256s: [],
  captureComplete: true,
  availability: { status: "available", reason: null },
  commandEvents: [
    {
      sequence: 1,
      producerKind: "native-helper",
      actionAttestationSha256: null,
      commandId: "home-identity",
      requestSha256: digest("e"),
      responseSha256: digest("f"),
      nativeTranscriptSha256s: [nativeTranscripts[0].transcriptSha256],
      observations: f01FactKeys.map(observation),
    },
  ],
};

const canonicalBytes = (value: unknown) => Buffer.from(canonicalProbeJson(value), "utf8");

function controllerReceiptFor(
  transcript: ProbeSourceTranscript,
): ProbeControllerSourceTranscriptReceipt {
  const fields: Omit<ProbeControllerSourceTranscriptReceipt, "signatureBase64" | "receiptSha256"> =
    {
      schemaVersion: 1,
      kind: "windows-host-probe-controller-source-transcript-receipt",
      sourceTranscriptSha256: hashProbeCanonicalJson(transcript),
      bindingSha256: hashProbeCanonicalJson({
        domain: "enduragent.windows-host-probe-source-transcript-binding.v1",
        binding: transcript.binding,
      }),
      producerKind: transcript.producer.kind,
      producerIdentitySha256: transcript.producer.identitySha256,
      nativeTranscriptSetSha256: hashProbeCanonicalJson({
        domain: "enduragent.windows-host-probe-native-transcript-set.v1",
        nativeTranscripts: transcript.nativeTranscripts,
      }),
      controllerIdentitySha256: expectedController.identitySha256,
      controllerPublicKeySha256: expectedController.publicKeySha256,
      controllerVersion: expectedController.version,
      signatureAlgorithm: "Ed25519",
    };
  const receiptSha256 = deriveControllerSourceTranscriptReceiptDigest(fields);
  return {
    ...fields,
    signatureBase64: sign(
      null,
      Buffer.from(receiptSha256, "hex"),
      controllerKeyPair.privateKey,
    ).toString("base64"),
    receiptSha256,
  };
}

const reducerInput = {
  sourceTranscriptBytes: canonicalBytes(sourceTranscript),
  expectedBinding: binding,
  expectedProducer: producer,
  expectedController,
  controllerPublicKeyBytes,
  controllerReceipt: controllerReceiptFor(sourceTranscript),
  trustedNativeTranscripts,
  trustedControllerActionAttestationBytes: [],
  trustedDefinition,
};

function reducerInputFor(transcript: ProbeSourceTranscript) {
  return {
    ...reducerInput,
    sourceTranscriptBytes: canonicalBytes(transcript),
    controllerReceipt: controllerReceiptFor(transcript),
  };
}

function controllerTranscriptFixture() {
  const controllerVerifier = getProbeVerifierDefinition(
    "F-06",
    "f06-baseline-after-flush-share-allows-replace",
  );
  const controllerFactValues: Readonly<Record<string, ProbeTranscriptFactValue>> = {
    context: "baseline",
    checkpoint: "after-flush",
    shareMode: "share-allows-replace",
    replaceDisposition: "committed",
    win32Error: null,
    reasonCode: null,
    oldRecordSha256: digest("a"),
    candidateRecordSha256: digest("b"),
    observedRecordSha256s: [digest("b")],
    partialRecordCount: 0,
    missingRecordCount: 0,
    readerSampleCount: 1,
    remainingOwnedTempCount: 0,
    retryCount: 0,
    elapsedMs: 1,
    defenderScanObserved: false,
    processCrashObserved: false,
    rebootObserved: false,
  };
  const controllerFactKeys = utf8Sort(Object.keys(controllerFactValues));
  const controllerBinding: ProbeSourceTranscriptBinding = {
    ...binding,
    rowId: controllerVerifier.rowId,
    variantId: controllerVerifier.variantId,
    verifierDefinitionSha256: controllerVerifier.definitionSha256,
  };
  const controllerProducer: ProbeTranscriptProducer = {
    kind: "external-controller",
    identitySha256: expectedController.identitySha256,
  };
  const controllerDefinition: TrustedProbeTranscriptDefinition = {
    rowId: controllerVerifier.rowId,
    variantId: controllerVerifier.variantId,
    definitionSha256: controllerVerifier.definitionSha256,
    verifierSourceSha256: controllerBinding.verifierSourceSha256,
    transcriptKind: controllerVerifier.transcriptKind,
    commands: [
      {
        commandId: controllerVerifier.transcriptCommandIds[0],
        factKeys: controllerFactKeys,
      },
    ],
  };
  const commandEvent = {
    sequence: 1,
    producerKind: "external-controller",
    commandId: controllerVerifier.transcriptCommandIds[0],
    requestSha256: digest("1"),
    responseSha256: digest("2"),
    nativeTranscriptSha256s: [nativeTranscripts[0].transcriptSha256],
    observations: controllerFactKeys.map((key) => observationFrom(controllerFactValues, key)),
  } as const;
  const actionAttestation = createProbeControllerActionAttestation({
    candidateSha256: controllerBinding.candidateSha256,
    executionBundleId: controllerBinding.executionBundleId,
    executionBundleManifestSha256: controllerBinding.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: digest("3"),
    coordinate: {
      campaignRunId: controllerBinding.campaignRunId,
      executionRunId: controllerBinding.executionRunId,
      attemptId: controllerBinding.attemptId,
      workId: "work-001",
      environmentId: controllerBinding.environmentId,
      pathProfileId: controllerBinding.pathProfileId,
      rowId: controllerBinding.rowId,
      variantId: controllerBinding.variantId,
      repetition: 1,
    },
    scenarioPlanSha256: digest("4"),
    producerActionId: "replace-file",
    operation: { operationId: "operation-001", kind: "scenario-action", sequence: 1 },
    runtimeActionIntentSha256: digest("5"),
    execution: {
      actor: "external-controller",
      operation: "run-replacement-campaign",
      locus: "controller-host",
      driverId: "f06-controller-driver",
      disruptive: false,
      nativeTranscriptRequired: true,
      actorSelector: { kind: "fixed", role: "controller" },
    },
    expectedActor: {
      role: "controller",
      identitySource: "controller.identitySha256",
      identitySha256: expectedController.identitySha256,
    },
    broker: null,
    observerCommands: [
      {
        transcriptSha256: nativeTranscripts[0].transcriptSha256,
        sequence: 1,
        commandId: commandEvent.commandId,
        requestFrameSha256: commandEvent.requestSha256,
        responseFrameSha256: commandEvent.responseSha256,
        ok: true,
      },
    ],
  });
  const controllerSourceTranscript: ProbeSourceTranscript = {
    ...sourceTranscript,
    producer: controllerProducer,
    binding: controllerBinding,
    commandEvents: [
      {
        ...commandEvent,
        actionAttestationSha256: actionAttestation.attestationSha256,
      },
    ],
  };
  const controllerTrustedNativeTranscripts: readonly ProbeTrustedNativeTranscriptEvidence[] = [
    {
      ...trustedNativeTranscripts[0],
      commandRecords: [
        {
          command: commandEvent.commandId,
          requestFrameSha256: commandEvent.requestSha256,
          responseFrameSha256: commandEvent.responseSha256,
          ok: true,
        },
      ],
    },
  ];
  const input = {
    sourceTranscriptBytes: canonicalBytes(controllerSourceTranscript),
    expectedBinding: controllerBinding,
    expectedProducer: controllerProducer,
    expectedController,
    controllerPublicKeyBytes,
    controllerReceipt: controllerReceiptFor(controllerSourceTranscript),
    trustedNativeTranscripts: controllerTrustedNativeTranscripts,
    trustedControllerActionAttestationBytes: [canonicalBytes(actionAttestation)],
    trustedDefinition: controllerDefinition,
  };
  return {
    actionAttestation,
    commandEvent,
    controllerDefinition,
    controllerFactValues,
    controllerSourceTranscript,
    input,
  };
}

function actionAttestationCreateInput(
  value: ReturnType<typeof createProbeControllerActionAttestation>,
) {
  return {
    candidateSha256: value.candidateSha256,
    executionBundleId: value.executionBundleId,
    executionBundleManifestSha256: value.executionBundleManifestSha256,
    runAuthorizationClaimReceiptSha256: value.runAuthorizationClaimReceiptSha256,
    coordinate: value.coordinate,
    scenarioPlanSha256: value.scenarioPlanSha256,
    producerActionId: value.producerActionId,
    operation: value.operation,
    runtimeActionIntentSha256: value.runtimeActionIntentSha256,
    execution: value.execution,
    expectedActor: value.expectedActor,
    broker: value.broker,
    observerCommands: value.observerCommands,
  };
}

function expectCode(work: () => unknown, code: string) {
  try {
    work();
    throw new Error("expected probe transcript reduction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeTranscriptError);
    expect(error).toMatchObject({ code });
  }
}

describe("Windows host source transcript trust boundary", () => {
  it("deterministically derives the registry raw-facts envelope from canonical primitive observations", () => {
    const rawFacts = reduceProbeSourceTranscript(reducerInput);
    const sourceTranscriptSha256 = hashProbeCanonicalJson(sourceTranscript);
    const expectedFacts = Object.fromEntries(f01FactKeys.map((key) => [key, factValues[key]]));

    expect(rawFacts).toMatchObject({
      schemaVersion: 1,
      kind: "windows-host-probe-raw-facts",
      captureComplete: true,
      availability: { status: "available", reason: null },
      scenario: {
        variantId: verifier.variantId,
        definitionSha256: verifier.definitionSha256,
        evidenceSha256: sourceTranscriptSha256,
        transcript: {
          schemaVersion: 1,
          kind: "windows-host-probe-native-transcript",
          rowId: verifier.rowId,
          variantId: verifier.variantId,
          verifierDefinitionSha256: verifier.definitionSha256,
          commandIds: ["home-identity"],
          sourceTranscriptSha256,
          factsSha256: hashProbeCanonicalJson({
            domain: "enduragent.windows-host-probe-transcript-facts.v1",
            rowId: verifier.rowId,
            variantId: verifier.variantId,
            facts: expectedFacts,
          }),
          captureSha256: hashProbeCanonicalJson({
            domain: "enduragent.windows-host-probe-transcript-capture.v1",
            rowId: verifier.rowId,
            variantId: verifier.variantId,
            schemaVersion: 1,
            kind: "windows-host-probe-raw-facts",
            captureComplete: true,
            availability: { status: "available", reason: null },
            facts: expectedFacts,
          }),
        },
      },
      facts: expectedFacts,
    });
    expect(Object.isFrozen(rawFacts)).toBe(true);
    expect(Object.isFrozen(rawFacts.facts)).toBe(true);
  });

  it("reduces a fact-producing native transcript alongside a separately signed observer", () => {
    const trustedWithObserver = [trustedNativeTranscripts[0], observerNativeTranscript];
    const transcriptWithObserver: ProbeSourceTranscript = {
      ...sourceTranscript,
      nativeTranscripts: trustedWithObserver.map(({ transcriptSha256, binding: entryBinding }) => ({
        transcriptSha256,
        binding: entryBinding,
      })),
      observerNativeTranscriptSha256s: [observerNativeTranscript.transcriptSha256],
    };

    const rawFacts = reduceProbeSourceTranscript({
      ...reducerInputFor(transcriptWithObserver),
      trustedNativeTranscripts: trustedWithObserver,
    });

    expect(rawFacts.facts).toEqual(factValues);
    expect(transcriptWithObserver.commandEvents[0].nativeTranscriptSha256s).toEqual([
      nativeTranscripts[0].transcriptSha256,
    ]);
  });

  it("rejects full-union event rewriting and forged observer classifications", () => {
    const trustedWithObserver = [trustedNativeTranscripts[0], observerNativeTranscript];
    const transcriptWithObserver: ProbeSourceTranscript = {
      ...sourceTranscript,
      nativeTranscripts: trustedWithObserver.map(({ transcriptSha256, binding: entryBinding }) => ({
        transcriptSha256,
        binding: entryBinding,
      })),
      observerNativeTranscriptSha256s: [observerNativeTranscript.transcriptSha256],
    };
    const rewrittenEvent: ProbeSourceTranscript = {
      ...transcriptWithObserver,
      commandEvents: [
        {
          ...transcriptWithObserver.commandEvents[0],
          nativeTranscriptSha256s: utf8Sort([
            nativeTranscripts[0].transcriptSha256,
            observerNativeTranscript.transcriptSha256,
          ]),
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInputFor(rewrittenEvent),
          trustedNativeTranscripts: trustedWithObserver,
        }),
      "TRANSCRIPT_NATIVE_EVENT_BINDING",
    );

    const factProducerRelabeledAsObserver: ProbeSourceTranscript = {
      ...sourceTranscript,
      observerNativeTranscriptSha256s: [nativeTranscripts[0].transcriptSha256],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(factProducerRelabeledAsObserver)),
      "TRANSCRIPT_NATIVE_OBSERVER_CLASSIFICATION",
    );
  });

  it("rejects duplicate, unordered, unknown, unclassified, and commandless observer evidence", () => {
    const trustedWithObserver = [trustedNativeTranscripts[0], observerNativeTranscript];
    const identitiesWithObserver = trustedWithObserver.map(
      ({ transcriptSha256, binding: entryBinding }) => ({
        transcriptSha256,
        binding: entryBinding,
      }),
    );
    const baseWithObserver: ProbeSourceTranscript = {
      ...sourceTranscript,
      nativeTranscripts: identitiesWithObserver,
      observerNativeTranscriptSha256s: [observerNativeTranscript.transcriptSha256],
    };
    for (const observerNativeTranscriptSha256s of [
      [observerNativeTranscript.transcriptSha256, observerNativeTranscript.transcriptSha256],
      [observerNativeTranscript.transcriptSha256, nativeTranscripts[0].transcriptSha256],
      [digest("f")],
    ]) {
      expectCode(
        () =>
          reduceProbeSourceTranscript({
            ...reducerInputFor({ ...baseWithObserver, observerNativeTranscriptSha256s }),
            trustedNativeTranscripts: trustedWithObserver,
          }),
        "TRANSCRIPT_NATIVE_OBSERVER_CLASSIFICATION",
      );
    }

    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInputFor({
            ...baseWithObserver,
            observerNativeTranscriptSha256s: [],
          }),
          trustedNativeTranscripts: trustedWithObserver,
        }),
      "TRANSCRIPT_NATIVE_OBSERVER_CLASSIFICATION",
    );
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInputFor(baseWithObserver),
          trustedNativeTranscripts: [
            trustedNativeTranscripts[0],
            { ...observerNativeTranscript, commandRecords: [] },
          ],
        }),
      "TRANSCRIPT_NATIVE_EVIDENCE",
    );
  });

  it("rejects duplicate, unordered, unknown, and wrong event transcript bindings", () => {
    for (const nativeTranscriptSha256s of [
      [nativeTranscripts[0].transcriptSha256, nativeTranscripts[0].transcriptSha256],
      [digest("f"), nativeTranscripts[0].transcriptSha256],
      [digest("f")],
    ]) {
      const invalidEvent: ProbeSourceTranscript = {
        ...sourceTranscript,
        commandEvents: [
          {
            ...sourceTranscript.commandEvents[0],
            nativeTranscriptSha256s,
          },
        ],
      };
      expectCode(
        () => reduceProbeSourceTranscript(reducerInputFor(invalidEvent)),
        "TRANSCRIPT_NATIVE_EVENT_BINDING",
      );
    }

    const wrongKnownTranscript: ProbeSourceTranscript = {
      ...sourceTranscript,
      nativeTranscripts: [
        {
          transcriptSha256: observerNativeTranscript.transcriptSha256,
          binding: observerNativeTranscript.binding,
        },
      ],
      commandEvents: [
        {
          ...sourceTranscript.commandEvents[0],
          nativeTranscriptSha256s: [observerNativeTranscript.transcriptSha256],
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInputFor(wrongKnownTranscript),
          trustedNativeTranscripts: [observerNativeTranscript],
        }),
      "TRANSCRIPT_NATIVE_COMMAND_BINDING",
    );
  });

  it("accepts an external-controller transcript only with the controller verifier kind", () => {
    const { controllerFactValues, input } = controllerTranscriptFixture();
    const rawFacts = reduceProbeSourceTranscript(input);

    expect(rawFacts.scenario.transcript.kind).toBe("windows-host-probe-controller-transcript");
    expect(rawFacts.scenario.transcript.commandIds).toEqual(["atomic-replacement-campaign"]);
    expect(rawFacts.facts).toEqual(controllerFactValues);
  });

  it("rejects a raw canonical artifact SHA substituted for the semantic action attestation digest", () => {
    const { actionAttestation, controllerSourceTranscript, input } = controllerTranscriptFixture();
    const rawArtifactSha256 = sha256(canonicalBytes(actionAttestation));
    expect(rawArtifactSha256).not.toBe(actionAttestation.attestationSha256);
    const substitutedTranscript: ProbeSourceTranscript = {
      ...controllerSourceTranscript,
      commandEvents: [
        {
          ...controllerSourceTranscript.commandEvents[0],
          actionAttestationSha256: rawArtifactSha256,
        },
      ],
    };

    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...input,
          sourceTranscriptBytes: canonicalBytes(substitutedTranscript),
          controllerReceipt: controllerReceiptFor(substitutedTranscript),
        }),
      "TRANSCRIPT_ACTION_ATTESTATION",
    );
  });

  it("accepts a recomputed repetition only when the caller independently trusts that exact attestation", () => {
    const { actionAttestation, controllerFactValues, controllerSourceTranscript, input } =
      controllerTranscriptFixture();
    const recomputedWrongRepetition = createProbeControllerActionAttestation({
      ...actionAttestationCreateInput(actionAttestation),
      coordinate: { ...actionAttestation.coordinate, repetition: 2 },
    });
    const matchingTranscript: ProbeSourceTranscript = {
      ...controllerSourceTranscript,
      commandEvents: [
        {
          ...controllerSourceTranscript.commandEvents[0],
          actionAttestationSha256: recomputedWrongRepetition.attestationSha256,
        },
      ],
    };

    expect(
      reduceProbeSourceTranscript({
        ...input,
        sourceTranscriptBytes: canonicalBytes(matchingTranscript),
        controllerReceipt: controllerReceiptFor(matchingTranscript),
        trustedControllerActionAttestationBytes: [canonicalBytes(recomputedWrongRepetition)],
      }).facts,
    ).toEqual(controllerFactValues);
  });

  it("keeps a remote-peer actor identity distinct from its attested process SID", () => {
    const { actionAttestation, controllerSourceTranscript, input } = controllerTranscriptFixture();
    const remoteAttestation = createProbeControllerActionAttestation({
      ...actionAttestationCreateInput(actionAttestation),
      execution: {
        ...actionAttestation.execution,
        locus: "controller-remote-peer",
        driverId: "f08-remote-peer-driver",
        actorSelector: { kind: "fixed", role: "remote-peer" },
      },
      expectedActor: {
        role: "remote-peer",
        identitySource: "actors.remotePeerActorSha256",
        identitySha256: digest("e"),
      },
      broker: {
        brokerAcceptanceSha256: digest("3"),
        brokerTaskSha256: digest("4"),
        brokerTaskNonceSha256: digest("5"),
        brokerResultSha256: digest("6"),
        brokerEnrollmentSha256: digest("7"),
        brokerInstanceId: "remote-peer-broker-001",
        brokerRole: "remote-peer",
        mailboxAclSha256: digest("8"),
        processSidSha256: digest("f"),
        bootIdSha256: controllerSourceTranscript.binding.bootIdSha256,
        runnerSessionIdSha256: controllerSourceTranscript.binding.runnerSessionIdSha256,
        replayJournalDisposition: "accepted",
        replayJournalEntrySha256: digest("9"),
      },
    });
    expect(remoteAttestation.expectedActor.identitySha256).not.toBe(
      remoteAttestation.broker?.processSidSha256,
    );
    const remoteTranscript: ProbeSourceTranscript = {
      ...controllerSourceTranscript,
      commandEvents: [
        {
          ...controllerSourceTranscript.commandEvents[0],
          actionAttestationSha256: remoteAttestation.attestationSha256,
        },
      ],
    };
    expect(
      reduceProbeSourceTranscript({
        ...input,
        sourceTranscriptBytes: canonicalBytes(remoteTranscript),
        controllerReceipt: controllerReceiptFor(remoteTranscript),
        trustedControllerActionAttestationBytes: [canonicalBytes(remoteAttestation)],
      }).facts,
    ).toEqual(controllerTranscriptFixture().controllerFactValues);

    for (const tamperedAttestation of [
      {
        ...remoteAttestation,
        expectedActor: { ...remoteAttestation.expectedActor, identitySha256: digest("d") },
      },
      {
        ...remoteAttestation,
        broker: { ...remoteAttestation.broker!, processSidSha256: digest("d") },
      },
    ]) {
      expectCode(
        () =>
          reduceProbeSourceTranscript({
            ...input,
            sourceTranscriptBytes: canonicalBytes(remoteTranscript),
            controllerReceipt: controllerReceiptFor(remoteTranscript),
            trustedControllerActionAttestationBytes: [canonicalBytes(tamperedAttestation)],
          }),
        "TRANSCRIPT_ACTION_ATTESTATION",
      );
    }
  });

  it("requires one exact independently trusted action attestation per controller event", () => {
    const { actionAttestation, controllerSourceTranscript, input } = controllerTranscriptFixture();
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...input,
          trustedControllerActionAttestationBytes: [],
        }),
      "TRANSCRIPT_ACTION_ATTESTATION",
    );

    const omittedAttestation: ProbeSourceTranscript = {
      ...controllerSourceTranscript,
      commandEvents: [
        {
          ...controllerSourceTranscript.commandEvents[0],
          actionAttestationSha256: null,
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...input,
          sourceTranscriptBytes: canonicalBytes(omittedAttestation),
          controllerReceipt: controllerReceiptFor(omittedAttestation),
        }),
      "TRANSCRIPT_ACTION_ATTESTATION",
    );

    const reusedSameRunAttestation = createProbeControllerActionAttestation({
      ...actionAttestationCreateInput(actionAttestation),
      coordinate: { ...actionAttestation.coordinate, repetition: 2 },
      producerActionId: "unrelated-action",
      operation: { ...actionAttestation.operation, operationId: "operation-002" },
    });
    const reusedProofTranscript: ProbeSourceTranscript = {
      ...controllerSourceTranscript,
      commandEvents: [
        {
          ...controllerSourceTranscript.commandEvents[0],
          actionAttestationSha256: reusedSameRunAttestation.attestationSha256,
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...input,
          sourceTranscriptBytes: canonicalBytes(reusedProofTranscript),
          controllerReceipt: controllerReceiptFor(reusedProofTranscript),
        }),
      "TRANSCRIPT_ACTION_ATTESTATION",
    );

    for (const trustedControllerActionAttestationBytes of [
      [canonicalBytes(actionAttestation), canonicalBytes(actionAttestation)],
      [canonicalBytes(actionAttestation), canonicalBytes(reusedSameRunAttestation)],
    ]) {
      expectCode(
        () =>
          reduceProbeSourceTranscript({
            ...input,
            trustedControllerActionAttestationBytes,
          }),
        "TRANSCRIPT_ACTION_ATTESTATION",
      );
    }
  });

  it("rejects action-attestation and observer-frame tampering during transcript replay", () => {
    const { actionAttestation, controllerSourceTranscript, input } = controllerTranscriptFixture();
    const digestTamper = {
      ...actionAttestation,
      runtimeActionIntentSha256: digest("f"),
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...input,
          trustedControllerActionAttestationBytes: [canonicalBytes(digestTamper)],
        }),
      "TRANSCRIPT_ACTION_ATTESTATION",
    );

    const frameTamper: ProbeSourceTranscript = {
      ...controllerSourceTranscript,
      commandEvents: [
        {
          ...controllerSourceTranscript.commandEvents[0],
          requestSha256: digest("f"),
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...input,
          sourceTranscriptBytes: canonicalBytes(frameTamper),
          controllerReceipt: controllerReceiptFor(frameTamper),
        }),
      "TRANSCRIPT_ACTION_ATTESTATION",
    );
  });

  it("rejects action attestations attached to native-helper command events", () => {
    const attachedAttestation: ProbeSourceTranscript = {
      ...sourceTranscript,
      commandEvents: [
        {
          ...sourceTranscript.commandEvents[0],
          actionAttestationSha256: digest("a"),
        },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(attachedAttestation)),
      "TRANSCRIPT_ACTION_ATTESTATION",
    );
  });

  it("rejects caller-supplied aggregate facts instead of letting them influence reduction", () => {
    const fabricatedRawFacts = {
      ...reduceProbeSourceTranscript(reducerInput),
      facts: { ...factValues, canonicalIdentitySha256: digest("0") },
    };
    const inputWithRawFacts = {
      ...reducerInput,
      rawFacts: fabricatedRawFacts,
    } as unknown as Parameters<typeof reduceProbeSourceTranscript>[0];
    expectCode(() => reduceProbeSourceTranscript(inputWithRawFacts), "TRANSCRIPT_INPUT");

    const transcriptWithRawFacts = {
      ...sourceTranscript,
      rawFacts: fabricatedRawFacts,
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(transcriptWithRawFacts),
        }),
      "TRANSCRIPT_SCHEMA",
    );
  });

  it("rejects invented observations paired with genuine native identities without a matching controller signature", () => {
    const fabricatedTranscript: ProbeSourceTranscript = {
      ...sourceTranscript,
      commandEvents: sourceTranscript.commandEvents.map((event) => ({
        ...event,
        observations: event.observations.map((entry) =>
          entry.factKey === "canonicalIdentitySha256"
            ? { ...entry, valueKind: "string", value: digest("0") }
            : entry,
        ),
      })),
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(fabricatedTranscript),
        }),
      "TRANSCRIPT_CONTROLLER_RECEIPT_BINDING",
    );

    const signatureBytes = Buffer.from(reducerInput.controllerReceipt.signatureBase64, "base64");
    signatureBytes[0] ^= 1;
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          controllerReceipt: {
            ...reducerInput.controllerReceipt,
            signatureBase64: signatureBytes.toString("base64"),
          },
        }),
      "TRANSCRIPT_CONTROLLER_SIGNATURE",
    );
  });

  it("rejects controller-signed native events without the exact retained command frames", () => {
    const inventedFrames: ProbeSourceTranscript = {
      ...sourceTranscript,
      commandEvents: [
        {
          ...sourceTranscript.commandEvents[0],
          requestSha256: digest("a"),
          responseSha256: digest("b"),
        },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(inventedFrames)),
      "TRANSCRIPT_NATIVE_COMMAND_BINDING",
    );
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          trustedNativeTranscripts: [{ ...trustedNativeTranscripts[0], commandRecords: [] }],
        }),
      "TRANSCRIPT_NATIVE_EVIDENCE",
    );
  });

  it("rejects noncanonical bytes, coordinate tampering, and command relabeling", () => {
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: Buffer.from(JSON.stringify(sourceTranscript), "utf8"),
        }),
      "TRANSCRIPT_CANONICAL",
    );

    const candidateTamper = {
      ...sourceTranscript,
      binding: { ...sourceTranscript.binding, candidateSha256: digest("0") },
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(candidateTamper),
        }),
      "TRANSCRIPT_BINDING_MISMATCH",
    );

    const commandRelabel = {
      ...sourceTranscript,
      commandEvents: [
        { ...sourceTranscript.commandEvents[0], commandId: "private-directory-inspect" },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(commandRelabel)),
      "TRANSCRIPT_COMMAND_SET",
    );

    const nativeEventRelabel = {
      ...sourceTranscript,
      commandEvents: [
        { ...sourceTranscript.commandEvents[0], nativeTranscriptSha256s: [digest("0")] },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(nativeEventRelabel)),
      "TRANSCRIPT_NATIVE_EVENT_BINDING",
    );
  });

  it("rejects producer relabeling and event producer-kind mismatches", () => {
    const producerRelabel = {
      ...sourceTranscript,
      producer: { kind: "external-controller", identitySha256: digest("6") },
      commandEvents: [
        { ...sourceTranscript.commandEvents[0], producerKind: "external-controller" },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(producerRelabel),
        }),
      "TRANSCRIPT_PRODUCER_MISMATCH",
    );

    const eventRelabel: ProbeSourceTranscript = {
      ...sourceTranscript,
      commandEvents: [
        { ...sourceTranscript.commandEvents[0], producerKind: "external-controller" },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(eventRelabel)),
      "TRANSCRIPT_PRODUCER_KIND",
    );
  });

  it("rejects loaded-image and native-session preflight identity mismatches", () => {
    const loadedImageBindingFields = {
      ...sourceTranscript.nativeTranscripts[0].binding,
      nativeHelperSha256: digest("0"),
    };
    const loadedImageStartupHandshake = createStartupHandshake(loadedImageBindingFields);
    const loadedImageTamper = {
      ...sourceTranscript,
      nativeTranscripts: [
        {
          ...sourceTranscript.nativeTranscripts[0],
          binding: {
            ...loadedImageBindingFields,
            startupHandshake: loadedImageStartupHandshake,
            startupHandshakeSha256: compactCanonicalDigest(loadedImageStartupHandshake),
          },
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(loadedImageTamper),
        }),
      "TRANSCRIPT_NATIVE_IDENTITY_MISMATCH",
    );

    const preflightTamper = {
      ...sourceTranscript,
      nativeTranscripts: [
        {
          ...sourceTranscript.nativeTranscripts[0],
          binding: {
            ...sourceTranscript.nativeTranscripts[0].binding,
            preflightSha256: digest("0"),
          },
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(preflightTamper),
        }),
      "TRANSCRIPT_NATIVE_CONTEXT",
    );

    const evidenceRootTamper = {
      ...sourceTranscript,
      nativeTranscripts: [
        {
          ...sourceTranscript.nativeTranscripts[0],
          binding: {
            ...sourceTranscript.nativeTranscripts[0].binding,
            evidenceRootObjectIdentitySha256: digest("0"),
          },
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(evidenceRootTamper),
        }),
      "TRANSCRIPT_NATIVE_CONTEXT",
    );

    const runRootTamper = {
      ...sourceTranscript,
      nativeTranscripts: [
        {
          ...sourceTranscript.nativeTranscripts[0],
          binding: {
            ...sourceTranscript.nativeTranscripts[0].binding,
            runRootIdentity: "volume-1:file-202",
          },
        },
      ],
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          sourceTranscriptBytes: canonicalBytes(runRootTamper),
        }),
      "TRANSCRIPT_NATIVE_CONTEXT",
    );
  });

  it("rejects retained native startup handshakes that do not prove the bound request", () => {
    const tamperedHandshake = {
      ...trustedNativeTranscripts[0].binding.startupHandshake,
      context: {
        ...trustedNativeTranscripts[0].binding.startupHandshake.context,
        requestFrameSha256: digest("0"),
      },
    };
    expectCode(
      () =>
        reduceProbeSourceTranscript({
          ...reducerInput,
          trustedNativeTranscripts: [
            {
              ...trustedNativeTranscripts[0],
              binding: {
                ...trustedNativeTranscripts[0].binding,
                startupHandshake: tamperedHandshake,
                startupHandshakeSha256: compactCanonicalDigest(tamperedHandshake),
              },
            },
          ],
        }),
      "TRANSCRIPT_NATIVE_HANDSHAKE",
    );

    for (const [field, value] of [
      ["nativeCandidateDigest", digest("1")],
      ["nativeManifestSha256", digest("2")],
    ] as const) {
      const identityTamperedHandshake = {
        ...trustedNativeTranscripts[0].binding.startupHandshake,
        context: {
          ...trustedNativeTranscripts[0].binding.startupHandshake.context,
          [field]: value,
        },
      };
      expectCode(
        () =>
          reduceProbeSourceTranscript({
            ...reducerInput,
            trustedNativeTranscripts: [
              {
                ...trustedNativeTranscripts[0],
                binding: {
                  ...trustedNativeTranscripts[0].binding,
                  startupHandshake: identityTamperedHandshake,
                  startupHandshakeSha256: compactCanonicalDigest(identityTamperedHandshake),
                },
              },
            ],
          }),
        "TRANSCRIPT_NATIVE_HANDSHAKE",
      );
    }
  });

  it("rejects unknown, duplicate, and missing fact observations", () => {
    const observations = sourceTranscript.commandEvents[0].observations;
    const missingFact = {
      ...sourceTranscript,
      commandEvents: [
        { ...sourceTranscript.commandEvents[0], observations: observations.slice(1) },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(missingFact)),
      "TRANSCRIPT_FACT_SET",
    );

    const duplicateFact = {
      ...sourceTranscript,
      commandEvents: [
        {
          ...sourceTranscript.commandEvents[0],
          observations: [
            observations[0],
            { ...observations[1], factKey: observations[0].factKey },
            ...observations.slice(2),
          ],
        },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(duplicateFact)),
      "TRANSCRIPT_FACT_SET",
    );

    const unknownFact = {
      ...sourceTranscript,
      commandEvents: [
        {
          ...sourceTranscript.commandEvents[0],
          observations: [
            { ...observations[0], factKey: "inventedAggregate" },
            ...observations.slice(1),
          ],
        },
      ],
    };
    expectCode(
      () => reduceProbeSourceTranscript(reducerInputFor(unknownFact)),
      "TRANSCRIPT_FACT_SET",
    );
  });
});
