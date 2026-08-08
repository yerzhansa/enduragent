import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  deriveLabAttestationDigest,
  type ProbeLabAttestation,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "../scripts/windows-host-falsifier/probe-runner.mjs";
import {
  ProbeRunAuthorizationError,
  deriveProbeOperatorTrustStoreDigest,
  deriveProbeRunAuthorizationClaimReceiptDigest,
  deriveProbeRunAuthorizationDigest,
  verifyProbeRunAuthorizationAtController,
  verifyProbeRunAuthorizationClaimReceipt,
  type ProbeOperatorTrustStore,
  type ProbeRunAuthorization,
  type ProbeRunAuthorizationClaimReceipt,
} from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const operatorPair = generateKeyPairSync("ed25519");
const operatorPublicKey = operatorPair.publicKey.export({ format: "der", type: "spki" });
const controllerPair = generateKeyPairSync("ed25519");
const controllerPublicKey = controllerPair.publicKey.export({ format: "der", type: "spki" });
const attestations = [
  { environmentId: "win11-current" as const, attestationSha256: "a".repeat(64) },
  { environmentId: "win11-floor" as const, attestationSha256: "b".repeat(64) },
];

function trustStore(status: "active" | "revoked" = "active"): ProbeOperatorTrustStore {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-operator-trust-store" as const,
    trustStoreId: "windows-lab-operators",
    generation: 7,
    keys: [
      {
        operatorKeyId: "operator-01",
        publicKeySpkiBase64: operatorPublicKey.toString("base64"),
        publicKeySha256: sha256(operatorPublicKey),
        status,
      },
    ],
  };
  return { ...unsigned, trustStoreSha256: deriveProbeOperatorTrustStoreDigest(unsigned) };
}

function authorization(attestationBindings = attestations): ProbeRunAuthorization {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization" as const,
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256: PROBE_RUN_PLAN_SHA256,
    candidateSha256: "c".repeat(64),
    campaignRunId: "campaign-run-01",
    attestations: attestationBindings,
    issuedAt: "2026-08-07T00:00:00.000Z",
    expiresAt: "2026-08-08T00:00:00.000Z",
    operatorKeyId: "operator-01",
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
      operatorPair.privateKey,
    ).toString("base64"),
  };
}

function attestation(): ProbeLabAttestation {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "sanitized-windows-11-lab-attestation" as const,
    environmentId: "win11-current" as const,
    sanitized: true as const,
    host: {
      windowsEdition: "Windows 11 Pro",
      osCaption: "Microsoft Windows 11 Pro",
      windowsVersion: "25H2",
      osBuild: "26200",
      patchLevel: "2026-08",
      productType: "workstation" as const,
      machineArchitecture: "x64" as const,
      processArchitecture: "x64" as const,
      systemVolumeFileSystem: "NTFS" as const,
      systemVolumeIdSha256: "1".repeat(64),
      testVolumeFileSystem: "NTFS" as const,
      testVolumeIdSha256: "2".repeat(64),
      standardUserSidSha256: "3".repeat(64),
      elevated: false as const,
      defenderRealtimeEnabled: true as const,
      uacDefault: true as const,
      developerModeEnabled: false as const,
    },
    snapshot: {
      vmImageId: "image-01",
      vmImageSha256: "4".repeat(64),
      vmSnapshotId: "snapshot-01",
      cleanImageVersion: "1.0.0",
    },
    runner: {
      version: "2.329.0",
      labels: [
        "enduragent-falsifier",
        "self-hosted",
        "win11-current",
        "windows",
        "windows-11",
        "x64",
      ],
      interactiveSessionOwnerSidSha256: "3".repeat(64),
    },
    runtime: {
      nodeVersion: "24.0.0",
      powerShellVersion: "5.1.0",
      powerShellEdition: "Desktop" as const,
      powerShellExecutableSha256: "5".repeat(64),
      clrVersion: "4.8.0",
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsisVersion: "3.11.0",
      nsisExecutableSha256: "6".repeat(64),
    },
    controller: {
      identitySha256: "7".repeat(64),
      publicKeySha256: sha256(controllerPublicKey),
      publicKeyArtifact: {
        path: "attestation/controller-public-key.der",
        sha256: sha256(controllerPublicKey),
      },
      version: "1.0.0",
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
        artifact: { path: "attestation/ascii-guest.json", sha256: "8".repeat(64) },
      },
      {
        pathProfileId: "spaces-unicode",
        artifact: { path: "attestation/unicode-guest.json", sha256: "a".repeat(64) },
      },
    ],
    controllerEvidence: { path: "attestation/controller.json", sha256: "9".repeat(64) },
  };
  return { ...unsigned, attestationSha256: deriveLabAttestationDigest(unsigned) };
}

function claimReceipt(
  authorizationValue: ProbeRunAuthorization,
  attestationValue: ProbeLabAttestation,
): ProbeRunAuthorizationClaimReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization-claim-receipt" as const,
    campaignId: authorizationValue.campaignId,
    manifestSha256: authorizationValue.manifestSha256,
    runPlanSha256: authorizationValue.runPlanSha256,
    candidateSha256: authorizationValue.candidateSha256,
    campaignRunId: authorizationValue.campaignRunId,
    environmentId: attestationValue.environmentId,
    labAttestationSha256: attestationValue.attestationSha256,
    evidenceRootObjectIdentitySha256: "d".repeat(64),
    authorizationSha256: authorizationValue.authorizationSha256,
    operatorKeyId: authorizationValue.operatorKeyId,
    operatorPublicKeySha256: sha256(operatorPublicKey),
    trustStoreId: authorizationValue.trustStoreId,
    trustStoreGeneration: authorizationValue.trustStoreGeneration,
    trustStoreSha256: trustStore().trustStoreSha256,
    verifiedAt: "2026-08-07T01:00:00.000Z",
    authorizationExpiresAt: authorizationValue.expiresAt,
    controllerIdentitySha256: attestationValue.controller.identitySha256,
    controllerPublicKeySha256: attestationValue.controller.publicKeySha256,
    controllerVersion: attestationValue.controller.version,
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveProbeRunAuthorizationClaimReceiptDigest(unsigned);
  return {
    ...unsigned,
    receiptSha256,
    signatureBase64: sign(
      null,
      Buffer.from(receiptSha256, "hex"),
      controllerPair.privateKey,
    ).toString("base64"),
  };
}

function expectCode(work: () => unknown, code: string) {
  try {
    work();
    throw new Error("expected run authorization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeRunAuthorizationError);
    expect(error).toMatchObject({ code });
  }
}

describe("Windows host probe operator authorization", () => {
  it("lets only the protected controller trust store verify an active operator signature", () => {
    const value = authorization();
    expect(
      verifyProbeRunAuthorizationAtController(value, {
        trustStore: trustStore(),
        candidateSha256: value.candidateSha256,
        campaignRunId: value.campaignRunId,
        attestations,
        verificationInstant: new Date("2026-08-07T01:00:00.000Z"),
      }),
    ).toMatchObject({ operatorPublicKeySha256: sha256(operatorPublicKey) });
    expectCode(
      () =>
        verifyProbeRunAuthorizationAtController(value, {
          trustStore: trustStore("revoked"),
          candidateSha256: value.candidateSha256,
          campaignRunId: value.campaignRunId,
          attestations,
          verificationInstant: new Date("2026-08-07T01:00:00.000Z"),
        }),
      "RUN_AUTH_UNTRUSTED_KEY",
    );
    expectCode(
      () =>
        verifyProbeRunAuthorizationAtController(value, {
          trustStore: trustStore(),
          candidateSha256: value.candidateSha256,
          campaignRunId: value.campaignRunId,
          attestations,
          verificationInstant: new Date(value.expiresAt),
        }),
      "RUN_AUTH_EXPIRED",
    );
  });

  it("accepts only an attested-controller claim bound to the root and authorization", () => {
    const authorizationValue = authorization();
    const attestationValue = attestation();
    const receipt = claimReceipt(authorizationValue, attestationValue);
    expect(
      verifyProbeRunAuthorizationClaimReceipt(receipt, {
        authorization: authorizationValue,
        attestation: attestationValue,
        controllerPublicKeyBytes: controllerPublicKey,
        evidenceRootObjectIdentitySha256: "d".repeat(64),
      }),
    ).toEqual(receipt);
    expectCode(
      () =>
        verifyProbeRunAuthorizationClaimReceipt(receipt, {
          authorization: authorizationValue,
          attestation: attestationValue,
          controllerPublicKeyBytes: controllerPublicKey,
          evidenceRootObjectIdentitySha256: "e".repeat(64),
        }),
      "RUN_AUTH_CLAIM_BINDING",
    );
    const changedSignature = Buffer.from(receipt.signatureBase64, "base64");
    changedSignature[0] ^= 1;
    expectCode(
      () =>
        verifyProbeRunAuthorizationClaimReceipt(
          { ...receipt, signatureBase64: changedSignature.toString("base64") },
          {
            authorization: authorizationValue,
            attestation: attestationValue,
            controllerPublicKeyBytes: controllerPublicKey,
            evidenceRootObjectIdentitySha256: "d".repeat(64),
          },
        ),
      "RUN_AUTH_CLAIM_SIGNATURE",
    );
  });

  it("binds both path-profile guest evidence references through the attestation digest", () => {
    const original = attestation();
    const originalBindings = [
      {
        environmentId: original.environmentId,
        attestationSha256: original.attestationSha256,
      },
      attestations[1],
    ];
    const value = authorization(originalBindings);
    expect(
      verifyProbeRunAuthorizationAtController(value, {
        trustStore: trustStore(),
        candidateSha256: value.candidateSha256,
        campaignRunId: value.campaignRunId,
        attestations: originalBindings,
        verificationInstant: new Date("2026-08-07T01:00:00.000Z"),
      }),
    ).toBeDefined();

    const changed = {
      ...original,
      guestEvidenceByPathProfile: [
        original.guestEvidenceByPathProfile[0],
        {
          ...original.guestEvidenceByPathProfile[1],
          artifact: {
            ...original.guestEvidenceByPathProfile[1].artifact,
            sha256: "b".repeat(64),
          },
        },
      ],
    };
    changed.attestationSha256 = deriveLabAttestationDigest(changed);
    expect(changed.attestationSha256).not.toBe(original.attestationSha256);
    expectCode(
      () =>
        verifyProbeRunAuthorizationAtController(value, {
          trustStore: trustStore(),
          candidateSha256: value.candidateSha256,
          campaignRunId: value.campaignRunId,
          attestations: [
            {
              environmentId: changed.environmentId,
              attestationSha256: changed.attestationSha256,
            },
            attestations[1],
          ],
          verificationInstant: new Date("2026-08-07T01:00:00.000Z"),
        }),
      "RUN_AUTH_BINDING",
    );
  });
});
