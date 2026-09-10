import { describe, expect, it } from "vitest";
import type {
  DroppedActivities,
  PowerProgressPanel,
  RecentRidesPanel,
  TrainingHistoryPanel,
} from "@enduragent/coach-contract";
import type { CyclingFtpAnchorResult } from "@enduragent/kernel/anchors";
import {
  ADHERENCE_MAX_RESTRICTED_ACTIVITIES,
  LOAD_MAX_RESTRICTED_SHARE,
  projectCyclingTrainingContext,
} from "../src/training-context.js";

const anchor: CyclingFtpAnchorResult = {
  kind: "ftp",
  watts: 250,
  validFrom: "2026-06-01",
  source: "manual",
  confidence: "manual",
  ageDays: 48,
  stalenessBand: "aging",
  stale: true,
};

const performanceProgress: PowerProgressPanel = {
  kind: "computed",
  currentWindow: { start: "1998-06-09", end: "1998-07-06" },
  previousWindow: { start: "1998-05-12", end: "1998-06-08" },
  anchors: ([5, 60, 300, 1_200, 3_600] as const).map((durationSeconds) => ({
    durationSeconds,
    current: { kind: "computed", watts: 300 },
    previous: { kind: "computed", watts: 280 },
    change: { kind: "computed", percent: 7.1 },
  })),
  rotation: "balanced",
  heartRateContext: { kind: "unavailable", reason: "insufficient-data" },
  sustainabilityContext: {
    kind: "computed",
    window: { start: "1998-05-26", end: "1998-07-06" },
    coverageRatio: 0.8,
    sourceContext: "mixed",
  },
  freshness: "fresh",
  asOf: "1998-07-06T09:00:00.000Z",
};

const recentRides: RecentRidesPanel = {
  kind: "computed",
  asOf: "1998-07-06T09:00:00.000Z",
  windowDays: 28,
  items: [
    {
      id: "a".repeat(64),
      subSport: "road",
      startEpochSeconds: 899_712_000,
      timezoneOffsetSeconds: 21_600,
      localDate: "1998-07-06",
      elapsedSeconds: 3_700,
      movingSeconds: 3_600,
      distanceMeters: 40_000,
    },
  ],
};

const trainingHistory: TrainingHistoryPanel = {
  kind: "unavailable",
  reason: "coverage-unavailable",
};

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "ride-1",
    start_date_local: "2026-07-17T07:00:00",
    type: "Ride",
    moving_time: 3600,
    elapsed_time: 3700,
    icu_training_load: 70,
    ...overrides,
  };
}

function wellness(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    weight: 70,
    restingHR: 48,
    hrv: 62,
    sleepSecs: 28_800,
    sleepQuality: 3,
    ...overrides,
  };
}

function droppedActivities(
  overallRestricted: number,
  overallTotal: number,
  recentRestricted: number,
  recentTotal: number,
): DroppedActivities {
  const window = (restricted: number, total: number) => ({
    total,
    visible: total - restricted,
    restrictions:
      restricted === 0
        ? []
        : [{ reason: "source-restricted" as const, source: "STRAVA", count: restricted }],
    other: 0,
  });
  return {
    overall: window(overallRestricted, overallTotal),
    recent7Days: window(recentRestricted, recentTotal),
  };
}

function project(overrides: Partial<Parameters<typeof projectCyclingTrainingContext>[0]> = {}) {
  return projectCyclingTrainingContext({
    asOf: "2026-07-18T00:00:00.000Z",
    anchor,
    derivedMetrics: {
      consistency_index: 0.75,
      consistency_details: { planned_days: 4, completed_days: 5, matched_days: 3 },
    },
    recentActivities: [activity(), activity({ id: "run-1", type: "Run", icu_training_load: 20 })],
    plannedWorkouts: [
      {
        id: 2,
        category: "WORKOUT",
        start_date_local: "2026-07-20T08:00:00",
        name: null,
        type: "Ride",
        moving_time: 5_400,
        icu_training_load: 120,
        description: "Race-specific endurance",
        workout_doc: { steps: [{ duration: 300 }] },
      },
    ],
    wellness: [wellness("2026-07-17")],
    performanceProgress,
    recentRides,
    trainingHistory,
    ...overrides,
  });
}

describe("cycling training context projection", () => {
  it("projects the canonical anchor and all six canonical zone rows", () => {
    const result = project();
    expect(result.anchorZones).toMatchObject({
      kind: "computed",
      anchor: {
        watts: anchor.watts,
        validFrom: anchor.validFrom,
        source: anchor.source,
        confidence: anchor.confidence,
        ageDays: anchor.ageDays,
        stalenessBand: anchor.stalenessBand,
        stale: anchor.stale,
      },
      zones: expect.arrayContaining([
        expect.objectContaining({ name: "Sweet Spot (88-94%)", overlaps: true }),
      ]),
    });
    if (result.anchorZones.kind === "computed") expect(result.anchorZones.zones).toHaveLength(6);
    expect(project({ anchor: null }).anchorZones).toEqual({
      kind: "unknown",
      reason: "not-synced",
    });
    expect(
      project({ anchor: { kind: "missing", refusal: "missing-cycling-ftp-anchor" } }).anchorZones,
    ).toEqual({ kind: "unknown", reason: "missing-anchor" });
  });

  it.each(["fresh", "aging", "stale", "very-stale"] as const)(
    "preserves the %s staleness band",
    (stalenessBand) => {
      const result = project({ anchor: { ...anchor, stalenessBand } });
      expect(
        result.anchorZones.kind === "computed" && result.anchorZones.anchor.stalenessBand,
      ).toBe(stalenessBand);
    },
  );

  it("aggregates only valid persisted cycling platform Load values", () => {
    const result = project({
      recentActivities: [
        activity({ id: "zero", icu_training_load: 0 }),
        activity({ id: "missing", icu_training_load: null }),
        activity({ id: "invalid", icu_training_load: -1 }),
        activity({ id: "nonfinite", icu_training_load: Number.POSITIVE_INFINITY }),
        activity({ id: "run", type: "Run", icu_training_load: 90 }),
      ],
    });
    expect(result.cyclingLoad).toEqual({
      kind: "computed",
      asOf: "2026-07-18T00:00:00.000Z",
      source: "intervals.icu",
      windowDays: 7,
      value: 0,
      activityCount: 2,
      missingLoadCount: 1,
    });
    expect(
      project({ recentActivities: [activity({ icu_training_load: null })] }).cyclingLoad,
    ).toEqual({
      kind: "unknown",
      reason: "no-platform-load",
    });
  });

  it("preserves every computed panel when no activities are restricted", () => {
    const baseline = project();
    const result = project({ droppedActivities: droppedActivities(0, 100, 0, 7) });
    expect(result).toEqual(baseline);
    expect({
      performanceProgress: result.performanceProgress.kind,
      recentRides: result.recentRides.kind,
      cyclingLoad: result.cyclingLoad.kind,
      adherence: result.adherence.kind,
    }).toMatchInlineSnapshot(`
      {
        "adherence": "computed",
        "cyclingLoad": "computed",
        "performanceProgress": "computed",
        "recentRides": "computed",
      }
    `);
  });

  it("refuses adherence after one restricted activity without hiding the other panels", () => {
    const result = project({ droppedActivities: droppedActivities(1, 100, 1, 100) });
    expect(result.adherence).toEqual({ kind: "unknown", reason: "source-restricted" });
    expect(result.cyclingLoad.kind).toBe("computed");
    expect(result.performanceProgress.kind).toBe("computed");
    expect(result.recentRides.kind).toBe("computed");
  });

  it("keeps broad panels computed below the restricted-share boundary", () => {
    const result = project({ droppedActivities: droppedActivities(49, 100, 49, 100) });
    expect(result.cyclingLoad.kind).toBe("computed");
    expect(result.performanceProgress.kind).toBe("computed");
    expect(result.recentRides.kind).toBe("computed");
  });

  it("refuses broad panels at the restricted-share boundary", () => {
    const result = project({ droppedActivities: droppedActivities(50, 100, 50, 100) });
    expect(result.cyclingLoad).toEqual({ kind: "unknown", reason: "source-restricted" });
    expect(result.performanceProgress).toEqual({
      kind: "unavailable",
      reason: "source-restricted",
    });
    expect(result.recentRides).toEqual({ kind: "unknown", reason: "source-restricted" });
    expect(result.trainingHistory).toEqual(trainingHistory);
    expect(result.adherence).toEqual({ kind: "unknown", reason: "source-restricted" });
  });

  it("combines restricted sources without treating other dropped rows as restrictions", () => {
    const restrictedWindow = {
      total: 100,
      visible: 49,
      restrictions: [
        { reason: "source-restricted" as const, source: "GARMIN_CONNECT", count: 25 },
        { reason: "source-restricted" as const, source: "STRAVA", count: 25 },
      ],
      other: 1,
    };
    const restricted = project({
      droppedActivities: { overall: restrictedWindow, recent7Days: restrictedWindow },
    });
    expect(restricted.cyclingLoad).toEqual({ kind: "unknown", reason: "source-restricted" });

    const otherOnlyWindow = {
      total: 100,
      visible: 49,
      restrictions: [],
      other: 51,
    };
    const otherOnly = project({
      droppedActivities: { overall: otherOnlyWindow, recent7Days: otherOnlyWindow },
    });
    expect(otherOnly.cyclingLoad.kind).toBe("computed");
    expect(otherOnly.adherence.kind).toBe("computed");
  });

  it("exports the refusal boundaries", () => {
    expect(ADHERENCE_MAX_RESTRICTED_ACTIVITIES).toBe(0);
    expect(LOAD_MAX_RESTRICTED_SHARE).toBe(0.5);
  });

  it("filters, sorts, and caps cycling plan rows", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: 20 - index,
      category: "WORKOUT",
      start_date_local: `2026-07-${String(20 + (index % 2)).padStart(2, "0")}T08:00:00`,
      name: index === 0 ? null : `Workout ${index}`,
      type: "Ride",
    }));
    rows.push({
      id: 100,
      category: "WORKOUT",
      start_date_local: "2026-07-19T08:00:00",
      name: "Run",
      type: "Run",
    });
    const result = project({ plannedWorkouts: rows });
    expect(result.plan.kind === "computed" && result.plan.items).toHaveLength(7);
    if (result.plan.kind === "computed") {
      expect(result.plan.items.map((item) => Number(item.id))).toEqual([
        12, 14, 16, 18, 20, 13, 15,
      ]);
    }
    expect(project({ plannedWorkouts: [] }).plan).toEqual({ kind: "unknown", reason: "no-plan" });
  });

  it("carries Planning fields while keeping Race events out of the workout panel", () => {
    const result = project({
      plannedWorkouts: [
        {
          id: 1,
          category: "WORKOUT",
          start_date_local: "2026-07-20T08:00:00",
          name: "Endurance",
          type: "Ride",
          moving_time: 5_400,
          icu_training_load: 120,
          description: "Race-specific endurance",
          workout_doc: { steps: [{ duration: 300 }] },
        },
        {
          id: 2,
          category: "RACE_A",
          start_date_local: "2026-07-21T08:00:00",
          name: "Gran Fondo",
        },
      ],
    });
    expect(result.plan).toEqual({
      kind: "computed",
      asOf: "2026-07-18T00:00:00.000Z",
      items: [
        {
          id: "1",
          date: "2026-07-20T08:00:00",
          name: "Endurance",
          category: "WORKOUT",
          workoutType: "Ride",
          durationSeconds: 5_400,
          load: 120,
          description: "Race-specific endurance",
          workoutDoc: { steps: [{ duration: 300 }] },
        },
      ],
    });
  });

  it("projects persisted adherence only when its complete shape is valid", () => {
    expect(project().adherence).toMatchObject({
      kind: "computed",
      ratio: 0.75,
      plannedDays: 4,
      completedDays: 5,
      matchedDays: 3,
    });
    expect(
      project({
        derivedMetrics: {
          consistency_index: 0,
          consistency_details: { planned_days: 0, completed_days: 0, matched_days: 0 },
        },
      }).adherence,
    ).toEqual({ kind: "unknown", reason: "no-plan" });
    expect(project({ derivedMetrics: { consistency_index: 2 } }).adherence).toEqual({
      kind: "unknown",
      reason: "insufficient-data",
    });
  });

  it("sorts and caps wellness rows while allowing partial series", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      wellness(`2026-07-${String(9 - index).padStart(2, "0")}`, {
        hrv: index === 0 ? null : 50 + index,
        sleepSecs: null,
      }),
    );
    const result = project({ wellness: rows });
    expect(result.wellnessTrend.kind).toBe("computed");
    if (result.wellnessTrend.kind === "computed") {
      expect(result.wellnessTrend.series.map((entry) => entry.points.length)).toEqual([6, 0, 7]);
      expect(result.wellnessTrend.series[0]?.points[0]?.date).toBe("2026-07-03");
    }
    expect(project({ wellness: {} }).wellnessTrend).toEqual({
      kind: "unknown",
      reason: "no-wellness",
    });
    expect(
      project({
        wellness: [wellness("2026-07-01", { hrv: null, sleepSecs: null, restingHR: null })],
      }).wellnessTrend,
    ).toEqual({
      kind: "unknown",
      reason: "insufficient-data",
    });
  });

  it("does not project unrelated wellness balance inputs", () => {
    const result = JSON.stringify(
      project({ wellness: [wellness("2026-07-17", { fitness: 80, fatigue: 70 })] }),
    );
    expect(result).not.toContain("fitness");
    expect(result).not.toContain("fatigue");
  });
});
