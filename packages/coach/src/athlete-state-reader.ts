import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AthleteStateSchema,
  EMPTY_DROPPED_ACTIVITIES,
  PowerProgressPanelSchema,
  RecentRidesPanelSchema,
  TrainingHistoryPanelSchema,
  TrainingHistoryProjectionSchema,
  UNKNOWN_CYCLING_TRAINING_CONTEXT,
  type AthleteState,
  type DroppedActivities,
  type PowerProgressPanel,
  type RecentRidesPanel,
  type TrainingHistoryComputed,
  type TrainingHistoryPanel,
} from "@enduragent/coach-contract";
import type { AthleteStateReaderPort } from "@enduragent/engine";
import type { CyclingFtpAnchorResolver } from "@enduragent/kernel/anchors";
import {
  ERROR_STATE_SCHEMA_VERSION,
  ErrorStateSchema,
  LATEST_SCHEMA_VERSION,
  LatestJsonSchema,
  SCHEDULER_SCHEMA_VERSION,
  SchedulerStateSchema,
} from "@enduragent/kernel/reference/schemas";
import { referenceFreshnessAt } from "@enduragent/kernel/reference/freshness";
import { projectCyclingTrainingContext } from "./training-context.js";
import type { TrainingHistorySource } from "./training-history.js";

export interface PersistedAthleteStateSource extends AthleteStateReaderPort {}

export class AthleteStateUnavailableError extends Error {}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;

function isFiniteInstant(value: string): boolean {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return false;
  const offsetSign = match[8] === "-" ? -1 : 1;
  const local = new Date(milliseconds + offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000);
  return (
    local.getUTCFullYear() === Number(match[1]) &&
    local.getUTCMonth() + 1 === Number(match[2]) &&
    local.getUTCDate() === Number(match[3]) &&
    local.getUTCHours() === Number(match[4]) &&
    local.getUTCMinutes() === Number(match[5]) &&
    local.getUTCSeconds() === Number(match[6])
  );
}

interface PersistedAthleteStateSourceBaseOptions {
  readonly dataDir: string;
  readonly cyclingFtpAnchorResolver: CyclingFtpAnchorResolver;
  readonly now?: () => Date;
  readonly powerProgressSource?: {
    readPowerProgress(): Promise<PowerProgressPanel>;
  };
  readonly recentRidesSource?: {
    readRecentRides(input: {
      readonly asOf: string;
      readonly asOfEpochSeconds: number;
    }): Promise<RecentRidesPanel>;
  };
  readonly droppedActivitiesSource?: () => DroppedActivities;
}

type TrainingHistorySourceOptions =
  | {
      readonly trainingHistorySource: TrainingHistorySource;
      readonly sourceOwner: () => string;
      readonly calendarTimeZone: () => string;
    }
  | {
      readonly trainingHistorySource?: undefined;
      readonly sourceOwner?: never;
      readonly calendarTimeZone?: never;
    };

export type CreatePersistedAthleteStateSourceOptions =
  PersistedAthleteStateSourceBaseOptions & TrainingHistorySourceOptions;

interface TrainingHistoryCacheIdentity {
  readonly athleteHomeRoot: string;
  readonly sourceOwner: string;
  readonly calendarTimeZone: string;
}

interface TrainingHistoryLastGood {
  readonly identity: TrainingHistoryCacheIdentity;
  readonly panel: TrainingHistoryComputed;
}

function sameTrainingHistoryIdentity(
  left: TrainingHistoryCacheIdentity,
  right: TrainingHistoryCacheIdentity,
): boolean {
  return (
    left.athleteHomeRoot === right.athleteHomeRoot &&
    left.sourceOwner === right.sourceOwner &&
    left.calendarTimeZone === right.calendarTimeZone
  );
}

function withoutTrainingHistoryCallouts(
  panel: TrainingHistoryComputed,
): TrainingHistoryComputed {
  return {
    ...panel,
    anchorWeek: { ...panel.anchorWeek, callout: null },
    previousWeek:
      panel.previousWeek === null
        ? null
        : { ...panel.previousWeek, callout: null },
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readRecentRides(
  source: CreatePersistedAthleteStateSourceOptions["recentRidesSource"],
  asOf: string,
  asOfEpochSeconds: number,
): Promise<RecentRidesPanel> {
  if (source === undefined) return { kind: "unknown", reason: "not-synced" };
  return source
    .readRecentRides({ asOf, asOfEpochSeconds })
    .then((value): RecentRidesPanel => {
      const parsed = RecentRidesPanelSchema.safeParse(value);
      return parsed.success ? parsed.data : { kind: "unknown", reason: "temporary-failure" };
    })
    .catch(
      (): RecentRidesPanel => ({
        kind: "unknown",
        reason: "temporary-failure",
      }),
    );
}

export function createPersistedAthleteStateSource(
  input: CreatePersistedAthleteStateSourceOptions,
): PersistedAthleteStateSource {
  const latestPath = join(input.dataDir, "data", "latest.json");
  const errorPath = join(input.dataDir, "data", "error_state.json");
  const schedulerPath = join(input.dataDir, "data", ".scheduler.json");
  let lastGoodTrainingHistory: TrainingHistoryLastGood | null = null;
  const temporaryFailureHistory = (
    identity: TrainingHistoryCacheIdentity,
    failedAt: string,
  ): TrainingHistoryPanel => {
    const cached = lastGoodTrainingHistory;
    if (cached === null || !sameTrainingHistoryIdentity(cached.identity, identity)) {
      return { kind: "unavailable", reason: "temporary-failure" };
    }
    return TrainingHistoryPanelSchema.parse({
      kind: "stale",
      failedAt,
      reason: "temporary-failure",
      lastGood: withoutTrainingHistoryCallouts(cached.panel),
    });
  };
  const readTrainingHistory = async (
    identity: TrainingHistoryCacheIdentity | null,
    request: Parameters<TrainingHistorySource["readTrainingHistory"]>[0],
  ): Promise<TrainingHistoryPanel> => {
    if (input.trainingHistorySource === undefined || identity === null) {
      return { kind: "unavailable", reason: "not-synced" };
    }
    try {
      const projection = await input.trainingHistorySource.readTrainingHistory(request);
      const parsed = TrainingHistoryProjectionSchema.safeParse(projection);
      if (!parsed.success) throw new TypeError("training history projection is invalid");
      if (parsed.data.kind === "computed") {
        lastGoodTrainingHistory = { identity, panel: parsed.data };
        return parsed.data;
      }
      if (parsed.data.reason === "temporary-failure") {
        return temporaryFailureHistory(identity, request.asOf);
      }
      return parsed.data;
    } catch {
      return temporaryFailureHistory(identity, request.asOf);
    }
  };
  return {
    async getAthleteState(): Promise<AthleteState> {
      const evaluatedAt = input.now?.() ?? new Date();
      const trainingHistoryIdentity: TrainingHistoryCacheIdentity | null =
        input.trainingHistorySource === undefined
          ? null
          : {
              athleteHomeRoot: input.dataDir,
              sourceOwner: input.sourceOwner(),
              calendarTimeZone: input.calendarTimeZone(),
            };
      if (
        lastGoodTrainingHistory !== null &&
        (trainingHistoryIdentity === null ||
          !sameTrainingHistoryIdentity(
            lastGoodTrainingHistory.identity,
            trainingHistoryIdentity,
          ))
      ) {
        lastGoodTrainingHistory = null;
      }
      const [schedulerResult] = await Promise.allSettled([readJson(schedulerPath)]);
      const [latestResult, errorResult] = await Promise.allSettled([
        readJson(latestPath),
        readJson(errorPath),
      ]);
      const schedulerParsed =
        schedulerResult.status === "fulfilled"
          ? SchedulerStateSchema.safeParse(schedulerResult.value)
          : null;
      const schedulerState =
        schedulerParsed?.success === true &&
        schedulerParsed.data.schema_version === SCHEDULER_SCHEMA_VERSION
          ? schedulerParsed.data
          : null;
      const committedSyncAt = schedulerState?.last_sync_at ?? null;
      const lastSynced =
        committedSyncAt !== null && isFiniteInstant(committedSyncAt) ? committedSyncAt : null;
      if (latestResult.status === "rejected") {
        if (
          isMissingFile(latestResult.reason) &&
          (input.recentRidesSource !== undefined || trainingHistoryIdentity !== null)
        ) {
          const asOf = evaluatedAt.toISOString();
          const asOfEpochSeconds = Math.floor(evaluatedAt.getTime() / 1_000);
          const freshness =
            lastSynced === null ? "fresh" : referenceFreshnessAt(lastSynced, evaluatedAt);
          const [recentRides, trainingHistory] = await Promise.all([
            readRecentRides(input.recentRidesSource, asOf, asOfEpochSeconds),
            trainingHistoryIdentity === null
              ? Promise.resolve({ kind: "unavailable", reason: "not-synced" } as const)
              : readTrainingHistory(trainingHistoryIdentity, {
                  asOf,
                  asOfEpochSeconds,
                  calendarTimeZone: trainingHistoryIdentity.calendarTimeZone,
                  freshness,
                  sourceRestricted: false,
                }),
          ]);
          return AthleteStateSchema.parse({
            schemaVersion: LATEST_SCHEMA_VERSION,
            lastUpdated: lastSynced ?? asOf,
            freshness,
            degraded: false,
            lastSynced,
            athleteProfile: null,
            currentStatus: null,
            derivedMetrics: {},
            recentActivities: [],
            plannedWorkouts: [],
            wellness: null,
            trainingContext: {
              ...UNKNOWN_CYCLING_TRAINING_CONTEXT,
              recentRides,
              trainingHistory,
            },
          });
        }
        throw new AthleteStateUnavailableError("No validated athlete state is available.");
      }
      const latestParsed = LatestJsonSchema.safeParse(latestResult.value);
      if (
        !latestParsed.success ||
        latestParsed.data.metadata.schema_version !== LATEST_SCHEMA_VERSION
      ) {
        throw new AthleteStateUnavailableError("No validated athlete state is available.");
      }
      const errorParsed =
        errorResult.status === "fulfilled" ? ErrorStateSchema.safeParse(errorResult.value) : null;
      const errorState =
        errorParsed?.success === true &&
        errorParsed.data.schema_version === ERROR_STATE_SCHEMA_VERSION
          ? errorParsed.data
          : null;
      const latest = latestParsed.data;
      const trainingHistoryFreshness = referenceFreshnessAt(
        lastSynced ?? latest.metadata.last_updated,
        evaluatedAt,
      );
      const derivedMetrics = { ...latest.derived_metrics };
      delete derivedMetrics.acwr;
      delete derivedMetrics["capability.dfa_a1_profile"];
      const parsedAsOf = Date.parse(latest.metadata.last_updated);
      const asOfEpochS =
        Number.isFinite(parsedAsOf) && parsedAsOf >= 0 ? Math.floor(parsedAsOf / 1_000) : null;
      const [anchor, performanceProgress, recentRides, trainingHistory] = await Promise.all([
        asOfEpochS === null
          ? Promise.resolve(null)
          : input.cyclingFtpAnchorResolver
              .resolve({ effectiveAtEpochS: asOfEpochS, evaluatedAtEpochS: asOfEpochS })
              .catch(() => null),
        input.powerProgressSource === undefined
          ? Promise.resolve({ kind: "unavailable", reason: "not-synced" } as const)
          : input.powerProgressSource
              .readPowerProgress()
              .then((value): PowerProgressPanel => {
                const parsed = PowerProgressPanelSchema.safeParse(value);
                return parsed.success
                  ? parsed.data
                  : { kind: "unavailable", reason: "invalid-data" };
              })
              .catch(
                (): PowerProgressPanel => ({
                  kind: "unavailable",
                  reason: "temporary-failure",
                }),
              ),
        asOfEpochS === null
          ? Promise.resolve({ kind: "unknown", reason: "not-synced" } as const)
          : readRecentRides(
              input.recentRidesSource,
              latest.metadata.last_updated,
              asOfEpochS,
            ),
        asOfEpochS === null || trainingHistoryIdentity === null
          ? Promise.resolve({ kind: "unavailable", reason: "not-synced" } as const)
          : readTrainingHistory(trainingHistoryIdentity, {
              asOf: evaluatedAt.toISOString(),
              asOfEpochSeconds: Math.floor(evaluatedAt.getTime() / 1_000),
              calendarTimeZone: trainingHistoryIdentity.calendarTimeZone,
              freshness: trainingHistoryFreshness,
              sourceRestricted: errorState?.mitigation === "block_coaching",
            }),
      ]);
      const trainingContext = projectCyclingTrainingContext({
        asOf: latest.metadata.last_updated,
        anchor,
        derivedMetrics,
        recentActivities: latest.recent_activities,
        plannedWorkouts: latest.planned_workouts,
        wellness: latest.wellness_data,
        performanceProgress,
        recentRides,
        trainingHistory,
        droppedActivities:
          input.droppedActivitiesSource?.() ?? EMPTY_DROPPED_ACTIVITIES,
      });
      const mapped = {
        schemaVersion: latest.metadata.schema_version,
        lastUpdated: latest.metadata.last_updated,
        freshness: latest.metadata.freshness,
        degraded: errorState?.mitigation === "block_coaching",
        lastSynced,
        athleteProfile: latest.athlete_profile,
        currentStatus: latest.current_status,
        derivedMetrics,
        ...(latest.derived_metrics_meta === undefined
          ? {}
          : { derivedMetricsMeta: latest.derived_metrics_meta }),
        recentActivities: latest.recent_activities,
        plannedWorkouts: latest.planned_workouts,
        wellness: latest.wellness_data,
        trainingContext,
      };
      const state = AthleteStateSchema.safeParse(mapped);
      if (!state.success) {
        throw new AthleteStateUnavailableError(
          "Persisted athlete state does not satisfy the coaching contract.",
        );
      }
      return state.data;
    },
  };
}
