import { describe, it, expect } from "vitest";

import {
  EXIT_SUCCESS,
  EXIT_AGENT_ERROR,
  EXIT_USAGE,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_NOT_CONFIGURED,
  EXIT_VERSION_MISMATCH,
  EXIT_CHECKSUM_MISMATCH,
  PROTOCOL_VERSION,
  TurnEventSchema,
  AthleteStateSchema,
  AdherencePanelSchema,
  CyclingLoadPanelSchema,
  CyclingTrainingContextSchema,
  CompletedActivityWeekSchema,
  DistanceMetricValueSchema,
  DurationMetricValueSchema,
  LoadMetricValueSchema,
  PowerProgressPanelSchema,
  RecentRidesPanelSchema,
  RideCountMetricValueSchema,
  RidingTimeTrendSchema,
  TrainingHistoryPanelSchema,
  TrainingHistoryProjectionSchema,
  TrainingHistoryRideSchema,
  TrainingRideCalloutSchema,
  UNKNOWN_CYCLING_TRAINING_CONTEXT,
  ChatRequestSchema,
  ChatResponseSchema,
  StopChatRequestSchema,
  ResetSessionResponseSchema,
  HasSessionResponseSchema,
  type CoachEngine,
  CACHING_UNAVAILABLE_DISCLOSURE,
  GetSpendSummaryRpcParamsSchema,
  SetDailySpendCapRpcParamsSchema,
  SpendRouteSummarySchema,
  SpendSummarySchema,
  ConfigureTelegramRpcParamsSchema,
  ReplaceTelegramRpcParamsSchema,
  TelegramChannelStatusSchema,
} from "../src/index.js";

const TURN_ID = "b8b6c1a2-0000-4000-8000-000000000001";

const errorEvent = {
  type: "error",
  turnId: TURN_ID,
  chatId: "telegram:12345",
  error_class: "rate_limit",
  kind: "rate_limit",
  athleteMessage: "Rate limited — please try again in 30 seconds.",
  overflowAttempts: 0,
  timeoutAttempts: 0,
  rateLimitAttempts: 2,
  duration_ms: 4200,
  compactions: 0,
} as const;

const validState = {
  schemaVersion: "3",
  lastUpdated: "1998-07-06T09:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "1998-07-05T18:30:00.000Z",
  athleteProfile: { name: "Test Athlete" },
  currentStatus: { summary: "ready" },
  derivedMetrics: {
    monotony: 1.2,
    strain: 350,
    eftp: 250,
    "capability.hrrc": { note: "ok" },
    some_future_metric: 1,
  },
  derivedMetricsMeta: {
    sportFamily: "cycling",
    prescriptionBasis: "power",
    anchorType: "ftp",
    analysisBasis: "power",
  },
  recentActivities: [],
  plannedWorkouts: [],
  wellness: { restingHr: 45 },
} as const;

const computedPowerProgress = {
  kind: "computed",
  currentWindow: { start: "1998-06-09", end: "1998-07-06" },
  previousWindow: { start: "1998-05-12", end: "1998-06-08" },
  anchors: [5, 60, 300, 1_200, 3_600].map((durationSeconds) => ({
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
} as const;

const trainingHistoryRides = [
  {
    id: "a".repeat(64),
    title: "Long endurance ride",
    subSport: "road",
    startEpochSeconds: 899_800_000,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-07-10",
    ridingSeconds: 7_200,
    ridingTimeBasis: "moving",
    elapsedSeconds: 7_500,
    distanceMeters: 60_000,
    load: 110,
    averagePowerWatts: 210,
    averageHeartRateBpm: 145,
    perceivedExertion: 6,
    energyKilojoules: 1_500,
  },
  {
    id: "b".repeat(64),
    title: null,
    subSport: null,
    startEpochSeconds: 899_700_000,
    timezoneOffsetSeconds: null,
    localDate: "1998-07-08",
    ridingSeconds: 3_600,
    ridingTimeBasis: "elapsed",
    elapsedSeconds: 3_600,
    distanceMeters: null,
    load: null,
    averagePowerWatts: null,
    averageHeartRateBpm: null,
    perceivedExertion: null,
    energyKilojoules: null,
  },
] as const;

const trainingHistoryCallout = {
  kind: "longest-ride-28d",
  rideId: trainingHistoryRides[0].id,
  durationSeconds: trainingHistoryRides[0].ridingSeconds,
  window: { start: "1998-06-09", end: "1998-07-06" },
  comparisonRideCount: 4,
} as const;

const computedTrainingHistory = {
  kind: "computed",
  asOf: "1998-07-12T23:59:59.000Z",
  calendarTimeZone: "UTC",
  displayMode: "current",
  coverage: {
    kind: "contiguous",
    start: "1998-05-18",
    through: "1998-07-12",
    committedAt: "1998-07-12T22:00:00.000Z",
  },
  anchorWeek: {
    id: "anchor",
    window: { start: "1998-07-06", end: "1998-07-12" },
    calendarState: "closed",
    coverage: { kind: "complete" },
    totals: {
      rideCount: { kind: "computed", value: 2 },
      ridingSeconds: { kind: "computed", value: 10_800 },
      distanceMeters: {
        kind: "partial",
        value: 60_000,
        reason: "missing-recorded-value",
        knownRideMissingValueCount: 1,
      },
      load: {
        kind: "partial",
        value: 110,
        reason: "missing-recorded-value",
        knownRideMissingValueCount: 1,
      },
    },
    rides: {
      count: { kind: "exact", value: 2 },
      items: trainingHistoryRides,
      truncated: false,
    },
    trend: {
      kind: "computed",
      buckets: [
        { window: { start: "1998-05-18", end: "1998-05-24" }, rideCount: 1, ridingSeconds: 3_600 },
        { window: { start: "1998-05-25", end: "1998-05-31" }, rideCount: 2, ridingSeconds: 7_200 },
        { window: { start: "1998-06-01", end: "1998-06-07" }, rideCount: 1, ridingSeconds: 4_000 },
        { window: { start: "1998-06-08", end: "1998-06-14" }, rideCount: 3, ridingSeconds: 9_000 },
        { window: { start: "1998-06-15", end: "1998-06-21" }, rideCount: 2, ridingSeconds: 6_000 },
        { window: { start: "1998-06-22", end: "1998-06-28" }, rideCount: 1, ridingSeconds: 3_000 },
      ],
    },
    callout: trainingHistoryCallout,
  },
  previousWeek: {
    id: "previous",
    window: { start: "1998-06-29", end: "1998-07-05" },
    calendarState: "closed",
    coverage: { kind: "complete" },
    totals: {
      rideCount: { kind: "computed", value: 0 },
      ridingSeconds: { kind: "computed", value: 0 },
      distanceMeters: { kind: "computed", value: 0 },
      load: { kind: "computed", value: 0 },
    },
    rides: { count: { kind: "exact", value: 0 }, items: [], truncated: false },
    trend: { kind: "unavailable", reason: "limited-history" },
    callout: null,
  },
} as const;

function cloneState(): Record<string, unknown> {
  return structuredClone(validState) as unknown as Record<string, unknown>;
}

describe("exit codes", () => {
  it("keeps 0 through 5 and assigns only checksum mismatch to 7", () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_AGENT_ERROR).toBe(1);
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_DAEMON_UNAVAILABLE).toBe(3);
    expect(EXIT_NOT_CONFIGURED).toBe(4);
    expect(EXIT_VERSION_MISMATCH).toBe(5);
    expect(EXIT_CHECKSUM_MISMATCH).toBe(7);
  });
});

describe("protocol version", () => {
  it("is 36", () => {
    expect(PROTOCOL_VERSION).toBe(36);
  });

  it("requires Stop to name the exact active turn", () => {
    expect(StopChatRequestSchema.parse({ chatId: "desktop", turnId: TURN_ID })).toEqual({
      chatId: "desktop",
      turnId: TURN_ID,
    });
    expect(() => StopChatRequestSchema.parse({ chatId: "desktop" })).toThrow();
    expect(() =>
      StopChatRequestSchema.parse({ chatId: "desktop", turnId: TURN_ID, extra: true }),
    ).toThrow();
  });
});

describe("Telegram control contract", () => {
  it("keeps credentials request-only and status metadata closed", () => {
    expect(ConfigureTelegramRpcParamsSchema.parse({ token: "bot-token" })).toEqual({
      token: "bot-token",
    });
    expect(ReplaceTelegramRpcParamsSchema.parse({ token: "replacement-token" })).toEqual({
      token: "replacement-token",
    });
    expect(
      TelegramChannelStatusSchema.parse({
        desiredState: "enabled",
        state: "waiting-for-credential",
      }),
    ).toEqual({ desiredState: "enabled", state: "waiting-for-credential" });
    expect(
      TelegramChannelStatusSchema.safeParse({
        desiredState: "enabled",
        state: "online",
        token: "must-not-cross-response-boundary",
      }).success,
    ).toBe(false);
    expect(
      ConfigureTelegramRpcParamsSchema.safeParse({ token: " token-with-space " }).success,
    ).toBe(false);
  });
});

describe("spend contract", () => {
  const route = {
    provider: "synthetic-provider",
    model: "synthetic-model",
    generationCount: 1,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 0,
    providerReportedGenerationCount: 1,
    knownSpendUsd: 0.02,
    cacheReadTokens: 10,
    cacheReadSavingsUsd: 0.001,
    caching: "provider-dependent",
    disclosure: null,
  } as const;
  const summary = {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.5,
    knownSpendUsd: 0.02,
    generationCount: 1,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: true,
    capStatus: "below",
    cacheReadTokens: 10,
    knownCacheReadSavingsUsd: 0.001,
    cacheSavingsComplete: true,
    routes: [route],
  } as const;

  it("validates strict requests, routes, summaries, and the exact disclosure", () => {
    expect(GetSpendSummaryRpcParamsSchema.parse({})).toEqual({});
    expect(GetSpendSummaryRpcParamsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(SetDailySpendCapRpcParamsSchema.parse({ dailyCapUsd: 0.5 })).toEqual({
      dailyCapUsd: 0.5,
    });
    for (const dailyCapUsd of [0, -1, NaN, Infinity]) {
      expect(SetDailySpendCapRpcParamsSchema.safeParse({ dailyCapUsd }).success).toBe(false);
    }
    expect(SpendRouteSummarySchema.parse(route)).toEqual(route);
    expect(SpendSummarySchema.parse(summary)).toEqual(summary);
    expect(
      SpendRouteSummarySchema.parse({
        ...route,
        caching: "unavailable",
        disclosure: CACHING_UNAVAILABLE_DISCLOSURE,
      }).disclosure,
    ).toBe("caching unavailable on this route");
    expect(SpendRouteSummarySchema.safeParse({ ...route, extra: true }).success).toBe(false);
  });

  it("rejects contradictory route and aggregate invariants", () => {
    expect(SpendRouteSummarySchema.safeParse({ ...route, pricedGenerationCount: 0 }).success).toBe(
      false,
    );
    expect(
      SpendRouteSummarySchema.safeParse({
        ...route,
        caching: "unavailable",
        disclosure: null,
      }).success,
    ).toBe(false);
    for (const invalid of [
      { ...summary, knownSpendUsd: 0.03 },
      { ...summary, cacheReadTokens: 11 },
      { ...summary, knownCacheReadSavingsUsd: 0.002 },
      { ...summary, cacheSavingsComplete: false },
      { ...summary, spendComplete: false },
      { ...summary, capStatus: "unknown" },
    ]) {
      expect(SpendSummarySchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("TurnEvent", () => {
  it("accepts every variant", () => {
    const samples = [
      { type: "turn-start", turnId: TURN_ID, chatId: "telegram:12345" },
      { type: "tool-start", turnId: TURN_ID, toolName: "intervals_create_workout" },
      {
        type: "tool-end",
        turnId: TURN_ID,
        toolName: "intervals_create_workout",
        summary: "created a workout on the calendar",
      },
      { type: "step-text", turnId: TURN_ID, text: "Looking at your recent rides..." },
      { type: "final-text", turnId: TURN_ID, text: "Here is this week's plan." },
      errorEvent,
      { type: "text_delta", turnId: TURN_ID, delta: "wor" },
    ];
    for (const sample of samples) {
      expect(TurnEventSchema.parse(sample)).toEqual(sample);
    }
  });

  it("rejects an unknown tag", () => {
    expect(TurnEventSchema.safeParse({ type: "turn-end", turnId: "x" }).success).toBe(false);
  });

  it("variants are closed (strict)", () => {
    const withExtra = {
      type: "final-text",
      turnId: TURN_ID,
      text: "done",
      extra: "nope",
    };
    expect(TurnEventSchema.safeParse(withExtra).success).toBe(false);
  });

  it("rejects camelCase spellings of the frozen field names", () => {
    const { error_class: _ec, duration_ms: _dm, ...rest } = errorEvent;
    const camelCased = { ...rest, errorClass: "rate_limit", durationMs: 4200 };
    expect(TurnEventSchema.safeParse(camelCased).success).toBe(false);
  });

  it("text_delta is parseable today", () => {
    const sample = { type: "text_delta", turnId: TURN_ID, delta: "wor" };
    expect(TurnEventSchema.parse(sample)).toEqual(sample);
  });
});

describe("AthleteState", () => {
  it("accepts a representative full state", () => {
    expect(AthleteStateSchema.parse(validState)).toEqual(validState);
  });

  it("accepts lastSynced null", () => {
    const state = cloneState();
    state["lastSynced"] = null;
    expect(AthleteStateSchema.parse(state)).toEqual(state);
  });

  it("reveal fence — acwr: a state carrying the fenced key fails to parse", () => {
    const state = cloneState();
    (state["derivedMetrics"] as Record<string, unknown>)["acwr"] = 1.3;
    expect(AthleteStateSchema.safeParse(state).success).toBe(false);
  });

  it("reveal fence — capability.dfa_a1_profile: a state carrying the fenced key fails to parse", () => {
    const state = cloneState();
    (state["derivedMetrics"] as Record<string, unknown>)["capability.dfa_a1_profile"] = {};
    expect(AthleteStateSchema.safeParse(state).success).toBe(false);
  });

  it("parses computed and unknown training-context envelopes strictly", () => {
    const computed = {
      performanceProgress: { kind: "unavailable", reason: "not-synced" },
      recentRides: {
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
      },
      anchorZones: {
        kind: "computed",
        asOf: "1998-07-06T09:00:00.000Z",
        anchor: {
          watts: 250,
          validFrom: "1998-06-01",
          source: "manual",
          confidence: "manual",
          ageDays: 35,
          stalenessBand: "fresh",
          stale: false,
        },
        zones: Array.from({ length: 6 }, (_, index) => ({
          name: `Zone ${index + 1}`,
          range: `${index + 1} W`,
          overlaps: index === 3,
        })),
      },
      cyclingLoad: {
        kind: "computed",
        asOf: "1998-07-06T09:00:00.000Z",
        source: "intervals.icu",
        windowDays: 7,
        value: 120,
        activityCount: 2,
        missingLoadCount: 1,
      },
      plan: {
        kind: "computed",
        asOf: "1998-07-06T09:00:00.000Z",
        items: [
          { id: "1", date: "1998-07-07", name: null, category: "WORKOUT", workoutType: "Ride" },
        ],
      },
      adherence: {
        kind: "computed",
        asOf: "1998-07-06T09:00:00.000Z",
        ratio: 0.5,
        plannedDays: 2,
        completedDays: 3,
        matchedDays: 1,
      },
      wellnessTrend: {
        kind: "computed",
        asOf: "1998-07-06T09:00:00.000Z",
        windowDays: 7,
        series: [
          { metric: "hrv", unit: "ms", points: [{ date: "1998-07-06", value: 60 }] },
          { metric: "sleep", unit: "seconds", points: [] },
          { metric: "resting-hr", unit: "bpm", points: [] },
        ],
      },
      trainingHistory: { kind: "unavailable", reason: "not-synced" },
    } as const;
    expect(CyclingTrainingContextSchema.parse(computed)).toEqual(computed);
    const { recentRides: _recentRides, ...olderContext } = computed;
    expect(CyclingTrainingContextSchema.parse(olderContext).recentRides).toEqual({
      kind: "unknown",
      reason: "not-synced",
    });
    expect(CyclingTrainingContextSchema.parse(UNKNOWN_CYCLING_TRAINING_CONTEXT)).toEqual(
      UNKNOWN_CYCLING_TRAINING_CONTEXT,
    );
    expect(CyclingTrainingContextSchema.safeParse({ ...computed, extra: true }).success).toBe(
      false,
    );
    expect(
      CyclingTrainingContextSchema.safeParse({
        ...computed,
        adherence: { ...computed.adherence, ratio: 1.1 },
      }).success,
    ).toBe(false);
    const { trainingHistory: _trainingHistory, ...withoutTrainingHistory } = computed;
    expect(CyclingTrainingContextSchema.safeParse(withoutTrainingHistory).success).toBe(false);
  });

  it("round trips a computed training-history panel", () => {
    expect(TrainingHistoryProjectionSchema.parse(computedTrainingHistory)).toEqual(
      computedTrainingHistory,
    );
    expect(TrainingHistoryPanelSchema.parse(computedTrainingHistory)).toEqual(
      computedTrainingHistory,
    );
  });

  it("keeps stale state out of the training-history projection", () => {
    const lastGood = {
      ...computedTrainingHistory,
      anchorWeek: { ...computedTrainingHistory.anchorWeek, callout: null },
    } as const;
    const stale = {
      kind: "stale",
      failedAt: "1998-07-13T00:05:00.000Z",
      reason: "temporary-failure",
      lastGood,
    } as const;
    expect(TrainingHistoryPanelSchema.parse(stale)).toEqual(stale);
    expect(TrainingHistoryProjectionSchema.safeParse(stale).success).toBe(false);
  });

  it("accepts pre-1970 Monday weeks and rejects pre-1970 non-Monday starts", () => {
    const emptyWeek = computedTrainingHistory.previousWeek;
    const preEpochMonday = {
      ...emptyWeek,
      window: { start: "1969-12-29", end: "1970-01-04" },
    };
    expect(CompletedActivityWeekSchema.safeParse(preEpochMonday).success).toBe(true);
    const preEpochTuesday = {
      ...emptyWeek,
      window: { start: "1969-12-30", end: "1970-01-05" },
    };
    expect(CompletedActivityWeekSchema.safeParse(preEpochTuesday).success).toBe(false);
  });

  it("rejects non-adjacent previous weeks and non-contiguous trend buckets", () => {
    const detachedPrevious = {
      ...computedTrainingHistory,
      previousWeek: {
        ...computedTrainingHistory.previousWeek,
        window: { start: "1998-06-22", end: "1998-06-28" },
      },
    };
    expect(TrainingHistoryProjectionSchema.safeParse(detachedPrevious).success).toBe(false);
    const buckets = computedTrainingHistory.anchorWeek.trend.buckets;
    const gappedTrend = {
      kind: "computed",
      buckets: [
        ...buckets.slice(0, 5),
        { ...buckets[5], window: { start: "1998-07-06", end: "1998-07-12" } },
      ],
    };
    expect(RidingTimeTrendSchema.safeParse(gappedTrend).success).toBe(false);
    const descendingTrend = {
      kind: "computed",
      buckets: [...buckets].reverse(),
    };
    expect(RidingTimeTrendSchema.safeParse(descendingTrend).success).toBe(false);
    const offMondayTrend = {
      kind: "computed",
      buckets: buckets.map((bucket, index) =>
        index === 2
          ? { ...bucket, window: { start: "1998-06-02", end: "1998-06-08" } }
          : bucket,
      ),
    };
    expect(RidingTimeTrendSchema.safeParse(offMondayTrend).success).toBe(false);
  });

  it("rejects invalid completed-week windows, rides, ordering, and truncation", () => {
    const week = computedTrainingHistory.anchorWeek;
    const invalidWeeks = [
      { ...week, window: { start: "1998-07-07", end: "1998-07-13" } },
      {
        ...week,
        rides: {
          ...week.rides,
          items: [week.rides.items[0], { ...week.rides.items[1], localDate: "1998-07-13" }],
        },
      },
      {
        ...week,
        rides: {
          ...week.rides,
          items: [week.rides.items[0], { ...week.rides.items[1], id: week.rides.items[0].id }],
        },
      },
      { ...week, rides: { ...week.rides, items: [...week.rides.items].reverse() } },
      { ...week, rides: { ...week.rides, truncated: true } },
      { ...week, rides: { ...week.rides, count: { kind: "exact", value: 1 } } },
    ];
    for (const invalidWeek of invalidWeeks) {
      expect(CompletedActivityWeekSchema.safeParse(invalidWeek).success).toBe(false);
    }
  });

  it("parses every metric envelope arm and rejects unknown keys", () => {
    const metricCases = [
      {
        schema: RideCountMetricValueSchema,
        accepted: [
          { kind: "computed", value: 2 },
          { kind: "partial", value: 2, reason: "incomplete-coverage" },
          { kind: "unavailable", reason: "incomplete-coverage" },
        ],
      },
      {
        schema: DurationMetricValueSchema,
        accepted: [
          { kind: "computed", value: 3_600 },
          {
            kind: "partial",
            value: 3_600,
            reason: "missing-recorded-value",
            knownRideMissingValueCount: 1,
          },
          { kind: "partial", value: 3_600, reason: "incomplete-coverage" },
          { kind: "unavailable", reason: "no-recorded-value" },
        ],
      },
      {
        schema: DistanceMetricValueSchema,
        accepted: [
          { kind: "computed", value: 40_000 },
          {
            kind: "partial",
            value: 40_000,
            reason: "missing-recorded-value",
            knownRideMissingValueCount: 1,
          },
          { kind: "partial", value: 40_000, reason: "incomplete-coverage" },
          { kind: "unavailable", reason: "invalid-recorded-value" },
        ],
      },
      {
        schema: LoadMetricValueSchema,
        accepted: [
          { kind: "computed", value: 80 },
          {
            kind: "partial",
            value: 80,
            reason: "missing-recorded-value",
            knownRideMissingValueCount: 1,
          },
          { kind: "partial", value: 80, reason: "incomplete-coverage" },
          { kind: "unavailable", reason: "no-recorded-value" },
        ],
      },
    ];
    for (const { schema, accepted } of metricCases) {
      for (const value of accepted) {
        expect(schema.parse(value)).toEqual(value);
        expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
      }
    }
    expect(
      RideCountMetricValueSchema.safeParse({
        kind: "partial",
        value: 2,
        reason: "missing-recorded-value",
        knownRideMissingValueCount: 1,
      }).success,
    ).toBe(false);
  });

  it("requires a riding-time basis whenever riding seconds are present", () => {
    expect(
      TrainingHistoryRideSchema.safeParse({
        ...trainingHistoryRides[0],
        ridingTimeBasis: null,
      }).success,
    ).toBe(false);
  });

  it("requires callout windows to contain exactly 28 civil dates", () => {
    expect(TrainingRideCalloutSchema.parse(trainingHistoryCallout)).toEqual(
      trainingHistoryCallout,
    );
    expect(
      TrainingRideCalloutSchema.safeParse({
        ...trainingHistoryCallout,
        window: { start: "1998-06-10", end: "1998-07-06" },
      }).success,
    ).toBe(false);
  });

  it("requires both last-good week callouts to be null", () => {
    const lastGood = {
      ...computedTrainingHistory,
      anchorWeek: { ...computedTrainingHistory.anchorWeek, callout: null },
    } as const;
    const previousRide = {
      ...trainingHistoryRides[1],
      localDate: "1998-07-03",
    } as const;
    const previousCallout = {
      ...trainingHistoryCallout,
      rideId: previousRide.id,
      durationSeconds: previousRide.ridingSeconds,
      window: { start: "1998-06-08", end: "1998-07-05" },
    } as const;
    const withPreviousCallout = {
      ...lastGood,
      previousWeek: {
        ...lastGood.previousWeek,
        rides: { count: { kind: "exact", value: 1 }, items: [previousRide], truncated: false },
        callout: previousCallout,
      },
    } as const;
    expect(TrainingHistoryPanelSchema.safeParse(computedTrainingHistory).success).toBe(true);
    expect(TrainingHistoryPanelSchema.safeParse(withPreviousCallout).success).toBe(true);
    for (const invalidLastGood of [computedTrainingHistory, withPreviousCallout]) {
      expect(
        TrainingHistoryPanelSchema.safeParse({
          kind: "stale",
          failedAt: "1998-07-13T00:05:00.000Z",
          reason: "temporary-failure",
          lastGood: invalidLastGood,
        }).success,
      ).toBe(false);
    }
  });

  it("bounds Power Progress and preserves explicit unavailable and stale states", () => {
    expect(PowerProgressPanelSchema.parse(computedPowerProgress)).toEqual(computedPowerProgress);
    expect(
      PowerProgressPanelSchema.parse({
        kind: "stale",
        lastGood: computedPowerProgress,
        refreshFailure: { code: "timeout", failedAt: "1998-07-07T09:00:00.000Z" },
      }),
    ).toMatchObject({ kind: "stale", lastGood: computedPowerProgress });
    expect(PowerProgressPanelSchema.parse({ kind: "unavailable", reason: "not-synced" })).toEqual({
      kind: "unavailable",
      reason: "not-synced",
    });
    expect(
      PowerProgressPanelSchema.parse({ kind: "unavailable", reason: "source-restricted" }),
    ).toEqual({ kind: "unavailable", reason: "source-restricted" });
    expect(
      PowerProgressPanelSchema.safeParse({
        ...computedPowerProgress,
        anchors: [...computedPowerProgress.anchors].reverse(),
      }).success,
    ).toBe(false);
    expect(
      PowerProgressPanelSchema.safeParse({
        ...computedPowerProgress,
        anchors: computedPowerProgress.anchors.map((anchor, index) =>
          index === 0
            ? { ...anchor, current: { kind: "computed", watts: Number.POSITIVE_INFINITY } }
            : anchor,
        ),
      }).success,
    ).toBe(false);
    expect(
      PowerProgressPanelSchema.safeParse({
        ...computedPowerProgress,
        anchors: computedPowerProgress.anchors.map((anchor, index) =>
          index === 0 ? { ...anchor, current: { kind: "unavailable" } } : anchor,
        ),
      }).success,
    ).toBe(false);
  });

  it("accepts source-restricted as a refusal reason for load and adherence", () => {
    expect(CyclingLoadPanelSchema.parse({ kind: "unknown", reason: "source-restricted" })).toEqual({
      kind: "unknown",
      reason: "source-restricted",
    });
    expect(AdherencePanelSchema.parse({ kind: "unknown", reason: "source-restricted" })).toEqual({
      kind: "unknown",
      reason: "source-restricted",
    });
  });

  it("bounds recent rides and rejects provider-only or malformed fields", () => {
    const ride = {
      id: "a".repeat(64),
      subSport: "road",
      startEpochSeconds: 899_712_000,
      timezoneOffsetSeconds: 21_600,
      localDate: "1998-07-06",
      elapsedSeconds: 3_700,
      movingSeconds: 3_600,
      distanceMeters: 40_000,
    } as const;
    const panel = {
      kind: "computed",
      asOf: "1998-07-06T09:00:00.000Z",
      windowDays: 28,
      items: Array.from({ length: 8 }, (_, index) => ({
        ...ride,
        id: index.toString(16).padStart(64, "0"),
      })),
    } as const;
    expect(RecentRidesPanelSchema.parse(panel)).toEqual(panel);
    expect(RecentRidesPanelSchema.parse({ kind: "unknown", reason: "source-restricted" })).toEqual({
      kind: "unknown",
      reason: "source-restricted",
    });
    expect(
      RecentRidesPanelSchema.safeParse({ ...panel, items: [...panel.items, ride] }).success,
    ).toBe(false);
    expect(
      RecentRidesPanelSchema.safeParse({
        ...panel,
        items: [{ ...ride, providerActivityId: "private" }],
      }).success,
    ).toBe(false);
    expect(
      RecentRidesPanelSchema.safeParse({
        ...panel,
        items: [{ ...ride, localDate: "1998-02-30" }],
      }).success,
    ).toBe(false);
  });

  it("derivedMetricsMeta is strict", () => {
    const withExtraKey = cloneState();
    (withExtraKey["derivedMetricsMeta"] as Record<string, unknown>)["extra"] = 1;
    expect(AthleteStateSchema.safeParse(withExtraKey).success).toBe(false);

    const withBadAnchor = cloneState();
    (withBadAnchor["derivedMetricsMeta"] as Record<string, unknown>)["anchorType"] = "threshold";
    expect(AthleteStateSchema.safeParse(withBadAnchor).success).toBe(false);
  });

  it("envelope is strict", () => {
    const state = cloneState();
    state["unknownTopLevel"] = 1;
    expect(AthleteStateSchema.safeParse(state).success).toBe(false);
  });
});

describe("ChatRequest", () => {
  it("parses with and without turn, rejects unknown keys", () => {
    expect(ChatRequestSchema.safeParse({ chatId: "telegram:12345", message: "hi" }).success).toBe(
      true,
    );
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        turn: { resolvedCs: null },
      }).success,
    ).toBe(true);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        turn: { resolvedCs: { cs: 3.2 } },
      }).success,
    ).toBe(true);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        turn: {
          resolvedCs: null,
          referenceProvenance: { garmin: true, nonGarmin: false, unknown: false },
        },
      }).success,
    ).toBe(true);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        turn: { resolvedCs: null, extra: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("responses", () => {
  it("ChatResponse parses its valid sample and rejects an extra key", () => {
    expect(ChatResponseSchema.safeParse({ text: "ok" }).success).toBe(true);
    expect(ChatResponseSchema.safeParse({ text: "ok", extra: 1 }).success).toBe(false);
  });

  it("ResetSessionResponse parses its valid sample and rejects an extra key", () => {
    expect(ResetSessionResponseSchema.safeParse({ memoryFlushed: true }).success).toBe(true);
    expect(ResetSessionResponseSchema.safeParse({ memoryFlushed: true, extra: 1 }).success).toBe(
      false,
    );
  });

  it("HasSessionResponse parses its valid sample and rejects an extra key", () => {
    expect(HasSessionResponseSchema.safeParse({ hasSession: false }).success).toBe(true);
    expect(HasSessionResponseSchema.safeParse({ hasSession: false, extra: 1 }).success).toBe(false);
  });
});

describe("CoachEngine", () => {
  it("is implementable", async () => {
    const fake: CoachEngine = {
      chat: async () => ({ text: "" }),
      getCoachDecision: async () => ({ decision: null }),
      answerCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      skipCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      resumeCoachDecision: async () => {
        throw new Error("Coach decisions are not used in this test.");
      },
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
      getAthleteState: async () => AthleteStateSchema.parse(validState),
    };
    await expect(fake.chat({ chatId: "telegram:12345", message: "hi" })).resolves.toEqual({
      text: "",
    });
  });
});
