import type { ProbeEnvironmentId, ProbePathProfileId } from "./probe-contract.mjs";
import type { PreparedProbeContext, ProbeExecutionActors } from "./probe-preflight.mjs";

export const PROBE_CONTROLLER_PREPARED_AUTHORITY_SCHEMA_VERSION: 1;
export const PROBE_CONTROLLER_PREPARED_AUTHORITY_KIND: "windows-host-probe-controller-prepared-authority";

export class ProbeControllerPreparedAuthorityError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeControllerPreparedAuthority {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-prepared-authority";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly runPlanSha256: string;
  readonly runAuthorizationSha256: string;
  readonly runAuthorizationClaimReceiptSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly attemptId: string;
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly vmSnapshotId: string;
  readonly preflightSha256: string;
  readonly controller: {
    readonly identitySha256: string;
    readonly publicKeySha256: string;
    readonly version: string;
  };
  readonly actors: ProbeExecutionActors;
  readonly nativeHelper: {
    readonly artifactPath: string;
    readonly sha256: string;
    readonly nativeCandidateDigest: string;
    readonly nativeManifestSha256: string;
  };
  readonly evidenceRootObjectIdentitySha256: string;
}

export function validateProbeControllerPreparedAuthority(
  value: unknown,
): ProbeControllerPreparedAuthority;
export function createProbeControllerPreparedAuthority(
  preparedContext: PreparedProbeContext,
): ProbeControllerPreparedAuthority;
