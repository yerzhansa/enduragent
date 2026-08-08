import type {
  ProbeArtifactHash,
  ProbeCandidateIdentity,
  ProbeEnvironmentId,
  ProbeLabAttestation,
  ProbePathProfileId,
} from "./probe-contract.mjs";
import type { ProbeLifecyclePolicy } from "./probe-preflight.mjs";
import type { ProbeRunAuthorization } from "./probe-run-authorization.mjs";
import type { ProbeBrokerEnrollment } from "./broker/mailbox-protocol.mjs";

export const PROBE_BOOTSTRAP_SCHEMA_VERSION: 1;
export const PROBE_BOOTSTRAP_PATH: "bootstrap.json";
export const PROBE_BOOTSTRAP_MAXIMUM_BYTES: number;

export class ProbeBootstrapError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeBootstrapAttestationReference {
  readonly environmentId: ProbeEnvironmentId;
  readonly artifact: ProbeArtifactHash;
}

export interface ProbeBootstrapEvidenceRoot {
  readonly environmentId: ProbeEnvironmentId;
  readonly pathProfileId: ProbePathProfileId;
  readonly root: string;
}

export interface ProbeBootstrapControllerSpool {
  readonly root: string;
  readonly identitySha256: string;
  readonly publicKeySha256: string;
  readonly version: string;
}

export interface ProbeBootstrapDocument {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-bootstrap";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly campaignRunId: string;
  readonly runPlanSha256: string;
  readonly candidate: ProbeArtifactHash;
  readonly attestations: readonly ProbeBootstrapAttestationReference[];
  readonly runAuthorization: ProbeArtifactHash;
  readonly lifecyclePolicy: ProbeArtifactHash;
  readonly nativeCandidateManifest: ProbeArtifactHash;
  readonly candidateBinaries: {
    readonly nativeHelperArtifactPath: string;
    readonly nsisArtifactPath: string;
  };
  readonly repositoryRoot: string;
  readonly binaryRoot: string;
  readonly evidenceRoots: readonly ProbeBootstrapEvidenceRoot[];
  readonly controllerSpool: ProbeBootstrapControllerSpool;
  readonly brokerEnrollments: readonly ProbeBrokerEnrollment[];
}

export interface ProbeNativeCandidateManifest {
  readonly schemaVersion: 1;
  readonly candidateDigest: string;
  readonly assembly: {
    readonly name: "windows-host-falsifier-native.exe";
    readonly sha256: string;
  };
  readonly sourceBundleSha256: string;
  readonly toolchainDigest: string;
  readonly sources: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly toolchain: Readonly<Record<string, unknown>>;
}

export interface LoadedProbeBootstrap {
  readonly bootstrapSha256: string;
  readonly bootstrap: ProbeBootstrapDocument;
  readonly candidate: ProbeCandidateIdentity;
  readonly attestations: readonly ProbeLabAttestation[];
  readonly runAuthorization: ProbeRunAuthorization;
  readonly lifecyclePolicy: ProbeLifecyclePolicy;
  readonly nativeCandidateManifest: ProbeNativeCandidateManifest;
  readonly controllerPublicKeySpkiDerBase64: string;
}

export function loadProbeBootstrap(options: {
  readonly root: string;
  readonly expectedSha256: string;
}): Promise<LoadedProbeBootstrap>;
