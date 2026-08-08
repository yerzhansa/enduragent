import type { ProbeScenarioAction, ProbeScenarioActionInvocation } from "./probe-scenarios.mjs";

export const PROBE_ACTION_MAP_SCHEMA_VERSION: 1;

export type ProbeActionExecutionLocus =
  | "guest-native-helper"
  | "guest-standard-user-worker"
  | "guest-second-user-broker"
  | "controller-host"
  | "controller-remote-peer"
  | "controller-orchestrated-guest";

export const PROBE_EXECUTION_LOCI: readonly ProbeActionExecutionLocus[];

export type ProbeActionActorRole =
  | "primary-standard-user"
  | "controller"
  | "power-control"
  | "snapshot-control"
  | "remote-peer"
  | "second-user";

export const PROBE_ACTOR_ROLES: readonly ProbeActionActorRole[];

export type ProbeActionActorIdentitySource =
  | "actors.primaryStandardUserSidSha256"
  | "controller.identitySha256"
  | "actors.powerControlActorSha256"
  | "actors.snapshotControlActorSha256"
  | "actors.remotePeerActorSha256"
  | "actors.secondUserSidSha256";

export const PROBE_ACTOR_IDENTITY_SOURCES: Readonly<
  Record<ProbeActionActorRole, ProbeActionActorIdentitySource>
>;

export class ProbeActionMapError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ProbeActionActorSelector =
  | {
      readonly kind: "fixed";
      readonly role: ProbeActionActorRole;
    }
  | {
      readonly kind: "parameter";
      readonly parameter: "actor";
      readonly roleByValue: Readonly<{
        readonly "current-user": "primary-standard-user";
        readonly "second-user": "second-user";
      }>;
    };

export interface ProbeResolvedActionActor {
  readonly role: ProbeActionActorRole;
  readonly identitySource: ProbeActionActorIdentitySource;
}

export interface ProbeActionMapping {
  readonly actor: ProbeScenarioAction["actor"];
  readonly operation: string;
  readonly locus: ProbeActionExecutionLocus;
  readonly driverId: string;
  readonly disruptive: boolean;
  readonly nativeTranscriptRequired: boolean;
  readonly actorSelector: ProbeActionActorSelector;
}

export const PROBE_ACTION_MAPPINGS: readonly ProbeActionMapping[];

export interface ProbeActionMapAudit {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-action-map-audit";
  readonly scenarioDefinitionCount: number;
  readonly scenarioActionCount: number;
  readonly actionPairCount: number;
  readonly mappingCount: number;
}

export interface ProbeActionMapAuditOptions {
  readonly scenarioDefinitions?: readonly {
    readonly rowId: string;
    readonly variantId: string;
    readonly actions: readonly {
      readonly actor: ProbeScenarioAction["actor"];
      readonly operation: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
    }[];
  }[];
  readonly mappings?: readonly ProbeActionMapping[];
}

export function auditProbeActionMappings(options?: ProbeActionMapAuditOptions): ProbeActionMapAudit;

export function getProbeActionMapping(
  invocation: ProbeScenarioActionInvocation,
): ProbeActionMapping;

export function resolveProbeActionActor(
  invocation: ProbeScenarioActionInvocation,
): ProbeResolvedActionActor;
export function getProbeActionMapping(coordinates: {
  readonly actor: ProbeScenarioAction["actor"];
  readonly operation: string;
}): ProbeActionMapping;
export function getProbeActionMapping(
  actor: ProbeScenarioAction["actor"],
  operation: string,
): ProbeActionMapping;

export const PROBE_ACTION_MAP_AUDIT: ProbeActionMapAudit;
