import type { EvidenceStore } from "./evidence-store.mjs";
import type { NativeBuild } from "./native-client.mjs";
import type {
  ProbeAuthoritativeRuntime,
  ProbeAuthoritativeRuntimeConfig,
  ProbeRuntimeBrokerTransport,
  ProbeRuntimeControllerTransport,
  ProbeRuntimeNativeTransport,
} from "./probe-authoritative-runtime.mjs";
import type { LoadedProbeBootstrap } from "./probe-bootstrap.mjs";
import type { ProbePreflightRequest } from "./probe-preflight.mjs";

export const PROBE_PRODUCTION_COMPOSITION_SCHEMA_VERSION: 1;
export const PROBE_PRODUCTION_CLOCK_AUTHORITY: "attested-standard-user-system-clock";

export class ProbeProductionCompositionError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface ProbeProductionCompositionMetadata {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-production-composition-metadata";
  readonly clockAuthority: "attested-standard-user-system-clock";
  readonly networkTimeClaim: "none";
  readonly constructedAt: string;
  readonly constructionMonotonic: number;
  readonly nativeCandidateDirectory: string;
  readonly evidenceRootCount: 4;
}

export interface ProbeProductionLaneContext {
  readonly loadedBootstrap: LoadedProbeBootstrap;
  readonly nativeBuild: NativeBuild;
  readonly resolveStore: ProbeAuthoritativeRuntimeConfig["resolveStore"];
  readonly metadata: ProbeProductionCompositionMetadata;
}

export interface ProbeProductionNativeLane {
  readonly transport: ProbeRuntimeNativeTransport;
  readonly resolvePreflightRequest: (
    input: Parameters<ProbeAuthoritativeRuntimeConfig["resolvePreflightRequest"]>[0],
  ) =>
    | Omit<ProbePreflightRequest, "nativeCandidateDigest" | "nativeManifestSha256">
    | Promise<Omit<ProbePreflightRequest, "nativeCandidateDigest" | "nativeManifestSha256">>;
}

export interface ProbeProductionCompositionFactories {
  readonly loadBootstrap: (options: {
    readonly root: string;
    readonly expectedSha256: string;
  }) => LoadedProbeBootstrap | Promise<LoadedProbeBootstrap>;
  readonly loadNativeHelper: (options: {
    readonly candidateRoot: string;
    readonly candidateDirectory: string;
  }) => NativeBuild | Promise<NativeBuild>;
  readonly openEvidenceStore: (options: {
    readonly root: string;
  }) => EvidenceStore | Promise<EvidenceStore>;
  readonly createNativeLane: (
    context: ProbeProductionLaneContext,
  ) => ProbeProductionNativeLane | Promise<ProbeProductionNativeLane>;
  readonly createBrokerLane: (
    context: ProbeProductionLaneContext,
  ) => ProbeRuntimeBrokerTransport | Promise<ProbeRuntimeBrokerTransport>;
  readonly createControllerLane: (
    context: ProbeProductionLaneContext,
  ) => ProbeRuntimeControllerTransport | Promise<ProbeRuntimeControllerTransport>;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
}

export type ProbeAuthoritativeDispatchers = Pick<
  ProbeAuthoritativeRuntime,
  "prepare" | "segment" | "checkpoint" | "resume" | "finalizeSegment" | "finalizeCampaign"
>;

export interface ProbeProductionComposition {
  readonly loadedBootstrap: LoadedProbeBootstrap;
  readonly nativeBuild: NativeBuild;
  readonly runtime: ProbeAuthoritativeRuntime;
  readonly dispatchers: ProbeAuthoritativeDispatchers;
  readonly metadata: ProbeProductionCompositionMetadata;
}

export function createAuthoritativeProbeComposition(options: {
  readonly bootstrapRoot: string;
  readonly bootstrapSha256: string;
  readonly factories?: ProbeProductionCompositionFactories;
}): Promise<ProbeProductionComposition>;
