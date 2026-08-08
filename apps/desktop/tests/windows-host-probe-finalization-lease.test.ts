import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ProbeFinalizationLeaseError,
  deriveProbeFinalizationOperationDigest,
  deriveProbeQuiescenceAbandonmentReceiptDigest,
  deriveProbeQuiescenceCompletionReceiptDigest,
  deriveProbeQuiescenceLeaseReceiptDigest,
  deriveProbeSegmentCommitDigest,
  validateProbeFinalizationIntent,
  verifyProbeQuiescenceAbandonmentReceipt,
  verifyProbeQuiescenceCompletionReceipt,
  verifyProbeQuiescenceLeaseReceipt,
  verifyProbeQuiescenceLeaseTransition,
  verifyProbeSegmentCommitMarker,
  type ProbeFinalizationIntent,
  type ProbeQuiescenceCompletionReceipt,
  type ProbeQuiescenceLeaseReceipt,
  type ProbeSegmentCommitMarker,
} from "../scripts/windows-host-falsifier/probe-finalization-lease.mjs";

const pair = generateKeyPairSync("ed25519");
const publicKeyBytes = pair.publicKey.export({ format: "der", type: "spki" });
const publicKeySha256 = createHash("sha256").update(publicKeyBytes).digest("hex");
const controller = {
  identitySha256: "9".repeat(64),
  publicKeySha256,
  version: "1.0.0",
};

function intent(): ProbeFinalizationIntent {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-finalization-intent" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: "a".repeat(64),
    candidateSha256: "b".repeat(64),
    runAuthorizationSha256: "c".repeat(64),
    runAuthorizationClaimReceiptSha256: "1".repeat(64),
    campaignRunId: "campaign-run-01",
    executionRunId: "execution-run-01",
    executionBundleId: "execution-bundle-01",
    executionBundleManifestSha256: "d".repeat(64),
    attemptId: "attempt-01",
    environmentId: "win11-floor",
    pathProfileId: "system-volume-ascii",
    rowId: "f01",
    variantId: "f01-home-identity",
    evidenceRootObjectIdentitySha256: "2".repeat(64),
    continuationChainIds: ["chain-01"],
    upstreamSelectionDigests: ["e".repeat(64), "f".repeat(64)],
    startedAt: "2026-08-07T01:00:00.000Z",
  };
  return {
    ...unsigned,
    finalizationOperationSha256: deriveProbeFinalizationOperationDigest(unsigned),
  };
}

function lease(
  finalizationIntent: ProbeFinalizationIntent,
  renewalSequence = 0,
): ProbeQuiescenceLeaseReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-controller-quiescence-lease-receipt" as const,
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    runAuthorizationSha256: finalizationIntent.runAuthorizationSha256,
    runAuthorizationClaimReceiptSha256: finalizationIntent.runAuthorizationClaimReceiptSha256,
    evidenceRootObjectIdentitySha256: finalizationIntent.evidenceRootObjectIdentitySha256,
    leaseId: "lease-01",
    leaseEpoch: 1,
    renewalSequence,
    actorSetSha256: "3".repeat(64),
    acquiredAt: "2026-08-07T01:00:01.000Z",
    expiresAt: renewalSequence === 0 ? "2026-08-07T01:05:00.000Z" : "2026-08-07T01:10:00.000Z",
    state: "active" as const,
    controllerIdentitySha256: controller.identitySha256,
    controllerPublicKeySha256: controller.publicKeySha256,
    controllerVersion: controller.version,
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveProbeQuiescenceLeaseReceiptDigest(unsigned);
  return {
    ...unsigned,
    receiptSha256,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), pair.privateKey).toString(
      "base64",
    ),
  };
}

const segmentProof = {
  segmentPath: "segments/win11-floor/ascii/f01/variant/segment.json",
  segmentSha256: "4".repeat(64),
  segmentArtifactSha256: "5".repeat(64),
  verificationInputSha256: "6".repeat(64),
  outcomeEvidenceSha256: "7".repeat(64),
};

function completion(
  finalizationIntent: ProbeFinalizationIntent,
  leaseReceipt: ProbeQuiescenceLeaseReceipt,
): ProbeQuiescenceCompletionReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-controller-quiescence-completion-receipt" as const,
    finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
    leaseId: leaseReceipt.leaseId,
    leaseEpoch: leaseReceipt.leaseEpoch,
    leaseReceiptSha256: leaseReceipt.receiptSha256,
    evidenceCaptureReceiptSha256: "8".repeat(64),
    ...segmentProof,
    completedAt: "2026-08-07T01:02:00.000Z",
    state: "completed" as const,
    controllerIdentitySha256: controller.identitySha256,
    controllerPublicKeySha256: controller.publicKeySha256,
    controllerVersion: controller.version,
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveProbeQuiescenceCompletionReceiptDigest(unsigned);
  return {
    ...unsigned,
    receiptSha256,
    signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), pair.privateKey).toString(
      "base64",
    ),
  };
}

function expectCode(work: () => unknown, code: string) {
  try {
    work();
    throw new Error("expected finalization lease validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeFinalizationLeaseError);
    expect(error).toMatchObject({ code });
  }
}

describe("Windows host probe signed finalization lease", () => {
  it("binds a signed acquisition and monotonic renewal to the exact intent", () => {
    const finalizationIntent = intent();
    const acquisition = lease(finalizationIntent);
    const renewal = lease(finalizationIntent, 1);
    expect(validateProbeFinalizationIntent(finalizationIntent)).toEqual(finalizationIntent);
    expect(
      verifyProbeQuiescenceLeaseReceipt(acquisition, {
        finalizationIntent,
        controllerPublicKeyBytes: publicKeyBytes,
        expectedController: controller,
      }),
    ).toEqual(acquisition);
    expect(
      verifyProbeQuiescenceLeaseTransition(renewal, {
        previousReceipt: acquisition,
        finalizationIntent,
        controllerPublicKeyBytes: publicKeyBytes,
        expectedController: controller,
      }),
    ).toEqual(renewal);
    expectCode(
      () =>
        verifyProbeQuiescenceLeaseReceipt(
          { ...acquisition, runAuthorizationSha256: "0".repeat(64) },
          {
            finalizationIntent,
            controllerPublicKeyBytes: publicKeyBytes,
            expectedController: controller,
          },
        ),
      "FINALIZATION_LEASE_DIGEST",
    );
  });

  it("accepts completion and a local commit only for the same unexpired signed lease", () => {
    const finalizationIntent = intent();
    const acquisition = lease(finalizationIntent);
    const finalLease = lease(finalizationIntent, 1);
    const completed = completion(finalizationIntent, finalLease);
    expect(
      verifyProbeQuiescenceCompletionReceipt(completed, {
        finalizationIntent,
        leaseReceipt: finalLease,
        evidenceCaptureReceiptSha256: completed.evidenceCaptureReceiptSha256,
        segmentProof,
        controllerPublicKeyBytes: publicKeyBytes,
        expectedController: controller,
      }),
    ).toEqual(completed);
    const markerDraft = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-segment-commit" as const,
      finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
      runAuthorizationSha256: finalizationIntent.runAuthorizationSha256,
      runAuthorizationClaimReceiptSha256: finalizationIntent.runAuthorizationClaimReceiptSha256,
      leaseId: finalLease.leaseId,
      leaseEpoch: finalLease.leaseEpoch,
      acquisitionReceiptSha256: acquisition.receiptSha256,
      finalLeaseReceiptSha256: finalLease.receiptSha256,
      evidenceCaptureReceiptSha256: completed.evidenceCaptureReceiptSha256,
      completionReceiptSha256: completed.receiptSha256,
      ...segmentProof,
    };
    const marker: ProbeSegmentCommitMarker = {
      ...markerDraft,
      commitSha256: deriveProbeSegmentCommitDigest(markerDraft),
    };
    expect(
      verifyProbeSegmentCommitMarker(marker, {
        finalizationIntent,
        acquisitionReceipt: acquisition,
        finalLeaseReceipt: finalLease,
        completionReceipt: completed,
      }),
    ).toEqual(marker);
    expectCode(
      () =>
        verifyProbeSegmentCommitMarker(
          { ...marker, completionReceiptSha256: "0".repeat(64) },
          {
            finalizationIntent,
            acquisitionReceipt: acquisition,
            finalLeaseReceipt: finalLease,
            completionReceipt: completed,
          },
        ),
      "FINALIZATION_LEASE_DIGEST",
    );
  });

  it("rejects skipped renewals and verifies a signed terminal abandonment", () => {
    const finalizationIntent = intent();
    const acquisition = lease(finalizationIntent);
    expectCode(
      () =>
        verifyProbeQuiescenceLeaseTransition(lease(finalizationIntent, 2), {
          previousReceipt: acquisition,
          finalizationIntent,
          controllerPublicKeyBytes: publicKeyBytes,
          expectedController: controller,
        }),
      "FINALIZATION_LEASE_TRANSITION",
    );
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "windows-host-probe-controller-quiescence-abandonment-receipt" as const,
      finalizationOperationSha256: finalizationIntent.finalizationOperationSha256,
      leaseId: acquisition.leaseId,
      leaseEpoch: acquisition.leaseEpoch,
      leaseReceiptSha256: acquisition.receiptSha256,
      reasonCode: "verification-failed",
      abandonedAt: "2026-08-07T01:02:00.000Z",
      state: "abandoned" as const,
      controllerIdentitySha256: controller.identitySha256,
      controllerPublicKeySha256: controller.publicKeySha256,
      controllerVersion: controller.version,
      signatureAlgorithm: "Ed25519" as const,
    };
    const receiptSha256 = deriveProbeQuiescenceAbandonmentReceiptDigest(unsigned);
    const abandonment = {
      ...unsigned,
      receiptSha256,
      signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), pair.privateKey).toString(
        "base64",
      ),
    };
    expect(
      verifyProbeQuiescenceAbandonmentReceipt(abandonment, {
        finalizationIntent,
        leaseReceipt: acquisition,
        controllerPublicKeyBytes: publicKeyBytes,
        expectedController: controller,
      }),
    ).toEqual(abandonment);
    expectCode(
      () =>
        verifyProbeQuiescenceAbandonmentReceipt(
          { ...abandonment, reasonCode: "another-reason" },
          {
            finalizationIntent,
            leaseReceipt: acquisition,
            controllerPublicKeyBytes: publicKeyBytes,
            expectedController: controller,
          },
        ),
      "FINALIZATION_LEASE_DIGEST",
    );
  });
});
