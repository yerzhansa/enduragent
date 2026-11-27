import type {
  CyclingTrainingContext,
  CyclingZoneRow,
  DroppedActivities,
  PowerProgressPanel,
  RecentRidesPanel,
  TrainingHistoryPanel,
  WellnessSeries,
} from "@enduragent/coach-contract";
import type { CyclingFtpAnchorResult } from "@enduragent/kernel/anchors";
import {
  ActivitySchema,
  PlannedEventSchema,
  WellnessDaySchema,
} from "@enduragent/kernel/reference/schemas";
import { calculateCyclingZones, cyclingSport } from "@enduragent/sport-cycling";

export interface ProjectCyclingTrainingContextInput {
  readonly asOf: string;
  readonly anchor: CyclingFtpAnchorResult | null;
  readonly derivedMetrics: Record<string, unknown>;
  readonly recentActivities: readonly unknown[];
  readonly plannedWorkouts: readonly unknown[];
  readonly wellness: unknown;
  readonly performanceProgress?: PowerProgressPanel;
  readonly recentRides?: RecentRidesPanel;
  readonly trainingHistory: TrainingHistoryPanel;
  readonly droppedActivities?: DroppedActivities;
}

export const ADHERENCE_MAX_RESTRICTED_ACTIVITIES = 0;
export const LOAD_MAX_RESTRICTED_SHARE = 0.5;

const cyclingTypes = new Set<string>(cyclingSport.intervalsActivityTypes);

type DroppedActivitiesWindow = DroppedActivities["overall"];

function restrictedActivityCount(window: DroppedActivitiesWindow | undefined): number {
  return window?.restrictions.reduce((sum, entry) => sum + entry.count, 0) ?? 0;
}

function restrictedActivityShare(window: DroppedActivitiesWindow | undefined): number {
  if (window === undefined || window.total === 0) return 0;
  return restrictedActivityCount(window) / window.total;
}

function projectAnchorZones(
  input: ProjectCyclingTrainingContextInput,
): CyclingTrainingContext["anchorZones"] {
  if (input.anchor === null) return { kind: "unknown", reason: "not-synced" };
  if (input.anchor.kind === "missing") return { kind: "unknown", reason: "missing-anchor" };
  return {
    kind: "computed",
    asOf: input.asOf,
    anchor: {
      watts: input.anchor.watts,
      validFrom: input.anchor.validFrom,
      source: input.anchor.source,
      confidence: input.anchor.confidence,
      ageDays: input.anchor.ageDays,
      stalenessBand: input.anchor.stalenessBand,
      stale: input.anchor.stale,
    },
    zones: calculateCyclingZones(input.anchor.watts).map(
      (zone): CyclingZoneRow => ({
        name: zone.label,
        range: zone.value,
        overlaps: zone.overlaps ?? false,
      }),
    ),
  };
}

function projectCyclingLoad(
  input: ProjectCyclingTrainingContextInput,
): CyclingTrainingContext["cyclingLoad"] {
  if (restrictedActivityShare(input.droppedActivities?.recent7Days) >= LOAD_MAX_RESTRICTED_SHARE) {
    return { kind: "unknown", reason: "source-restricted" };
  }
  const activities = input.recentActivities.flatMap((row) => {
    const parsed = ActivitySchema.safeParse(row);
    return parsed.success && cyclingTypes.has(parsed.data.type) ? [parsed.data] : [];
  });
  const loads = activities.flatMap((activity) =>
    activity.icu_training_load == null ? [] : [activity.icu_training_load],
  );
  if (loads.length === 0) return { kind: "unknown", reason: "no-platform-load" };
  return {
    kind: "computed",
    asOf: input.asOf,
    source: "intervals.icu",
    windowDays: 7,
    value: loads.reduce((sum, value) => sum + value, 0),
    activityCount: activities.length,
    missingLoadCount: activities.length - loads.length,
  };
}

function projectPlan(input: ProjectCyclingTrainingContextInput): CyclingTrainingContext["plan"] {
  const items = input.plannedWorkouts
    .flatMap((row) => {
      const parsed = PlannedEventSchema.safeParse(row);
      return parsed.success &&
        parsed.data.category === "WORKOUT" &&
        parsed.data.type != null &&
        cyclingTypes.has(parsed.data.type)
        ? [parsed.data]
        : [];
    })
    .sort(
      (left, right) =>
        left.start_date_local.localeCompare(right.start_date_local) || left.id - right.id,
    )
    .slice(0, 7)
    .map((row) => ({
      id: String(row.id),
      date: row.start_date_local,
      name: row.name ?? null,
      category: row.category,
      workoutType: row.type as string,
      durationSeconds: row.moving_time ?? null,
      load: row.icu_training_load ?? null,
      description: row.description ?? null,
      workoutDoc: row.workout_doc ?? null,
    }));
  return items.length === 0
    ? { kind: "unknown", reason: "no-plan" }
    : { kind: "computed", asOf: input.asOf, items };
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function projectAdherence(
  input: ProjectCyclingTrainingContextInput,
): CyclingTrainingContext["adherence"] {
  if (
    restrictedActivityCount(input.droppedActivities?.recent7Days) >
    ADHERENCE_MAX_RESTRICTED_ACTIVITIES
  ) {
    return { kind: "unknown", reason: "source-restricted" };
  }
  const ratio = input.derivedMetrics.consistency_index;
  const details = input.derivedMetrics.consistency_details;
  if (
    typeof ratio !== "number" ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1 ||
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return { kind: "unknown", reason: "insufficient-data" };
  }
  const values = details as Record<string, unknown>;
  if (
    !nonnegativeInteger(values.planned_days) ||
    !nonnegativeInteger(values.completed_days) ||
    !nonnegativeInteger(values.matched_days)
  ) {
    return { kind: "unknown", reason: "insufficient-data" };
  }
  if (values.planned_days === 0) return { kind: "unknown", reason: "no-plan" };
  return {
    kind: "computed",
    asOf: input.asOf,
    ratio,
    plannedDays: values.planned_days,
    completedDays: values.completed_days,
    matchedDays: values.matched_days,
  };
}

function projectWellness(
  input: ProjectCyclingTrainingContextInput,
): CyclingTrainingContext["wellnessTrend"] {
  if (!Array.isArray(input.wellness)) return { kind: "unknown", reason: "no-wellness" };
  const rows = input.wellness
    .flatMap((row) => {
      const parsed = WellnessDaySchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(-7);
  if (rows.length === 0) return { kind: "unknown", reason: "no-wellness" };
  const series: WellnessSeries[] = [
    {
      metric: "hrv",
      unit: "ms",
      points: rows.flatMap((row) =>
        row.hrv == null || !Number.isFinite(row.hrv) ? [] : [{ date: row.id, value: row.hrv }],
      ),
    },
    {
      metric: "sleep",
      unit: "seconds",
      points: rows.flatMap((row) =>
        row.sleepSecs == null || !Number.isFinite(row.sleepSecs)
          ? []
          : [{ date: row.id, value: row.sleepSecs }],
      ),
    },
    {
      metric: "resting-hr",
      unit: "bpm",
      points: rows.flatMap((row) =>
        row.restingHR == null || !Number.isFinite(row.restingHR)
          ? []
          : [{ date: row.id, value: row.restingHR }],
      ),
    },
  ];
  if (series.every((entry) => entry.points.length === 0)) {
    return { kind: "unknown", reason: "insufficient-data" };
  }
  return { kind: "computed", asOf: input.asOf, windowDays: 7, series };
}

export function projectCyclingTrainingContext(
  input: ProjectCyclingTrainingContextInput,
): CyclingTrainingContext {
  const overallRestricted =
    restrictedActivityShare(input.droppedActivities?.overall) >= LOAD_MAX_RESTRICTED_SHARE;
  return {
    performanceProgress: overallRestricted
      ? { kind: "unavailable", reason: "source-restricted" }
      : (input.performanceProgress ?? {
          kind: "unavailable",
          reason: "not-synced",
        }),
    recentRides: overallRestricted
      ? { kind: "unknown", reason: "source-restricted" }
      : (input.recentRides ?? { kind: "unknown", reason: "not-synced" }),
    trainingHistory: input.trainingHistory,
    anchorZones: projectAnchorZones(input),
    cyclingLoad: projectCyclingLoad(input),
    plan: projectPlan(input),
    adherence: projectAdherence(input),
    wellnessTrend: projectWellness(input),
  };
}
