import type { ProbeEnvironmentId, ProbeLabAttestation } from "./probe-contract.mjs";

export const PROBE_RUN_AUTHORIZATION_SCHEMA_VERSION: 1;
export const PROBE_RUN_AUTHORIZATION_MAXIMUM_MS: number;

export class ProbeRunAuthorizationError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeOperatorTrustStore {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-operator-trust-store";
  readonly trustStoreId: string;
  readonly generation: number;
  readonly keys: readonly {
    readonly operatorKeyId: string;
    readonly publicKeySpkiBase64: string;
    readonly publicKeySha256: string;
    readonly status: "active" | "revoked";
  }[];
  readonly trustStoreSha256: string;
}

export interface ProbeRunAuthorization {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-run-authorization";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly candidateSha256: string;
  readonly campaignRunId: string;
  readonly attestations: readonly {
    readonly environmentId: ProbeEnvironmentId;
    readonly attestationSha256: string;
  }[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly operatorKeyId: string;
  readonly trustStoreId: string;
  readonly trustStoreGeneration: number;
  readonly signatureAlgorithm: "Ed25519";
  readonly authorizationSha256: string;
  readonly signatureBase64: string;
}

export interface ProbeRunAuthorizationClaimReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-run-authorization-claim-receipt";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly runPlanSha256: string;
  readonly candidateSha256: string;
  readonly campaignRunId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly labAttestationSha256: string;
  readonly evidenceRootObjectIdentitySha256: string;
  readonly authorizationSha256: string;
  readonly operatorKeyId: string;
  readonly operatorPublicKeySha256: string;
  readonly trustStoreId: string;
  readonly trustStoreGeneration: number;
  readonly trustStoreSha256: string;
  readonly verifiedAt: string;
  readonly authorizationExpiresAt: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly receiptSha256: string;
}

export function deriveProbeRunAuthorizationDigest(
  value:
    | Omit<ProbeRunAuthorization, "authorizationSha256" | "signatureBase64">
    | ProbeRunAuthorization,
): string;
export function deriveProbeOperatorTrustStoreDigest(
  value: Omit<ProbeOperatorTrustStore, "trustStoreSha256"> | ProbeOperatorTrustStore,
): string;
export function deriveProbeRunAuthorizationClaimReceiptDigest(
  value:
    | Omit<ProbeRunAuthorizationClaimReceipt, "receiptSha256" | "signatureBase64">
    | ProbeRunAuthorizationClaimReceipt,
): string;
export function validateProbeOperatorTrustStore(value: unknown): ProbeOperatorTrustStore;
export function validateProbeRunAuthorization(value: unknown): ProbeRunAuthorization;
export function verifyProbeRunAuthorizationAtController(
  value: unknown,
  options: {
    readonly trustStore: ProbeOperatorTrustStore;
    readonly candidateSha256: string;
    readonly campaignRunId: string;
    readonly attestations: readonly {
      readonly environmentId: ProbeEnvironmentId;
      readonly attestationSha256: string;
    }[];
    readonly verificationInstant: Date;
  },
): {
  readonly authorization: ProbeRunAuthorization;
  readonly trustStore: ProbeOperatorTrustStore;
  readonly operatorPublicKeySha256: string;
  readonly verifiedAt: string;
};
export function validateProbeRunAuthorizationClaimReceipt(
  value: unknown,
): ProbeRunAuthorizationClaimReceipt;
export function verifyProbeRunAuthorizationClaimReceipt(
  value: unknown,
  options: {
    readonly authorization: ProbeRunAuthorization;
    readonly attestation: ProbeLabAttestation;
    readonly controllerPublicKeyBytes: Uint8Array;
    readonly evidenceRootObjectIdentitySha256: string;
  },
): ProbeRunAuthorizationClaimReceipt;
