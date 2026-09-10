import { describe, expect, it, vi } from "vitest";
import type { ActivityAnalysisData, ActivityAnalysisRequest } from "@enduragent/coach-contract";
import type {
  ActivityAnalysisProjection,
  ActivityAnalysisProjectionKey,
  ActivityAnalysisProjectionRepository,
  CanonicalActivityDetail,
  TrustedActivitySourceResolver,
} from "@enduragent/kernel/store";
import {
  ActivityAnalysisComputationError,
  ActivityAnalysisServiceError,
  createActivityAnalysisService,
  type ActivityAnalysisSectionAnalyzer,
  type ActivityAnalysisSectionAnalyzers,
} from "../src/activity-analysis-service.js";

const ACTIVITY_ID = "a".repeat(64);
const WORKOUT_ID = "b".repeat(64);
const REVISION = "c".repeat(64);

const activity: CanonicalActivityDetail = {
  id: ACTIVITY_ID,
  workoutId: WORKOUT_ID,
  sessionSequence: 0,
  isMultisport: false,
  sport: "cycling",
  subSport: null,
  isTransition: false,
  startEpochSeconds: 899_985_600,
  timezoneOffsetSeconds: 0,
  localDate: "1998-07-06",
  elapsedSeconds: 3_600,
  timerSeconds: 3_500,
  movingSeconds: 3_400,
  distanceMeters: 40_000,
  laps: [],
};

const drift: ActivityAnalysisData["aerobicDrift"] = {
  method: "local-time-weighted-efficiency-factor",
  firstHalf: {
    durationSeconds: 1_700,
    sampleCount: 1_700,
    averagePowerWatts: 200,
    averageHeartRateBpm: 140,
    efficiencyFactor: 1.43,
  },
  secondHalf: {
    durationSeconds: 1_700,
    sampleCount: 1_700,
    averagePowerWatts: 200,
    averageHeartRateBpm: 145,
    efficiencyFactor: 1.38,
  },
  decouplingPercent: 3.5,
  coverage: {
    totalSamples: 3_400,
    validSamples: 3_400,
    includedDurationSeconds: 3_400,
    windowDurationSeconds: 3_400,
    fraction: 1,
  },
  evidence: "standard",
  limitations: [],
};

function cache(): ActivityAnalysisProjectionRepository & {
  readonly values: Map<string, ActivityAnalysisProjection>;
} {
  const values = new Map<string, ActivityAnalysisProjection>();
  const key = (value: ActivityAnalysisProjectionKey): string =>
    `${value.canonicalActivityId}:${value.sourceRevision}:${value.section}`;
  return {
    values,
    async read(value) {
      return values.get(key(value));
    },
    async write(value) {
      values.set(key(value), value);
    },
  };
}

function source(
  resolve: TrustedActivitySourceResolver["resolve"] = async () => ({
    kind: "resolved",
    providerActivityId: "provider-42" as never,
    sourceRevision: REVISION,
  }),
): TrustedActivitySourceResolver {
  return { resolve };
}

function setup(input: {
  readonly analyzer?: ActivityAnalysisSectionAnalyzer<"aerobicDrift">;
  readonly resolver?: TrustedActivitySourceResolver;
  readonly projectionCache?: ActivityAnalysisProjectionRepository;
  readonly activityValue?: CanonicalActivityDetail;
  readonly aggregateDeadlineMs?: number;
}) {
  const analyzer = input.analyzer ?? {
    analyze: async () => ({
      kind: "computed" as const,
      data: drift,
      source: "local-canonical" as const,
    }),
  };
  const getActivity = vi.fn(async () => input.activityValue ?? activity);
  const service = createActivityAnalysisService({
    activities: { getActivity },
    sources: input.resolver ?? source(),
    cache: input.projectionCache ?? cache(),
    analyzers: { aerobicDrift: analyzer },
    now: () => Date.parse("1998-07-06T12:00:00.000Z"),
    aggregateDeadlineMs: input.aggregateDeadlineMs,
  });
  return { service, getActivity, analyzer };
}

describe("activity analysis service", () => {
  it("returns a validated live section, then serves persisted last-good evidence", async () => {
    const projectionCache = cache();
    const analyze = vi.fn(async () => ({
      kind: "computed" as const,
      data: drift,
      source: "local-canonical" as const,
    }));
    const { service } = setup({ analyzer: { analyze }, projectionCache });
    const request: ActivityAnalysisRequest = {
      canonicalActivityId: ACTIVITY_ID,
      sections: ["aerobic-drift"],
    };

    await expect(service.getActivityAnalysis(request)).resolves.toMatchObject({
      schemaVersion: 1,
      revision: REVISION,
      sections: {
        aerobicDrift: {
          kind: "computed",
          data: drift,
          provenance: { source: "local-canonical", delivery: "live" },
        },
      },
    });
    expect(projectionCache.values.size).toBe(1);
    await expect(service.getActivityAnalysis(request)).resolves.toMatchObject({
      sections: {
        aerobicDrift: {
          kind: "computed",
          provenance: { delivery: "persisted-cache" },
        },
      },
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("preserves cached evidence as stale when an explicit refresh fails", async () => {
    let fail = false;
    const analyzer: ActivityAnalysisSectionAnalyzer<"aerobicDrift"> = {
      async analyze() {
        if (fail) throw new ActivityAnalysisComputationError("timeout");
        return { kind: "computed", data: drift, source: "local-canonical" };
      },
    };
    const { service } = setup({ analyzer });
    const request: ActivityAnalysisRequest = {
      canonicalActivityId: ACTIVITY_ID,
      sections: ["aerobic-drift"],
    };
    await service.getActivityAnalysis(request);
    fail = true;
    await expect(service.getActivityAnalysis({ ...request, refresh: true })).resolves.toMatchObject(
      {
        sections: {
          aerobicDrift: {
            kind: "stale",
            lastGood: { provenance: { delivery: "persisted-cache" } },
            refreshFailure: { code: "timeout", failedAt: "1998-07-06T12:00:00.000Z" },
          },
        },
      },
    );
  });

  it("isolates unsupported sections and does not expose provider identity", async () => {
    const { service } = setup({});
    const result = await service.getActivityAnalysis({
      canonicalActivityId: ACTIVITY_ID,
      sections: ["aerobic-drift", "intervals", "power-heart-rate"],
    });
    expect(result.sections.intervals).toEqual({ kind: "unavailable", reason: "unsupported" });
    expect(result.sections.powerHeartRate).toEqual({ kind: "unavailable", reason: "unsupported" });
    expect(JSON.stringify(result)).not.toContain("provider-42");
  });

  it("rejects provider provenance without a trusted provider source", async () => {
    const analyzer: ActivityAnalysisSectionAnalyzer<"aerobicDrift"> = {
      async analyze() {
        return { kind: "computed", data: drift, source: "provider" };
      },
    };
    const { service } = setup({
      analyzer,
      resolver: source(async () => ({ kind: "unavailable", reason: "not_found" })),
    });
    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "unavailable", reason: "malformed-response" } },
    });
  });

  it("classifies invalid analyzer data as a malformed response", async () => {
    const analyzer: ActivityAnalysisSectionAnalyzer<"aerobicDrift"> = {
      async analyze() {
        return {
          kind: "computed",
          data: { method: "wrong-method" },
          source: "local-canonical",
        } as never;
      },
    };
    const { service } = setup({ analyzer });
    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "unavailable", reason: "malformed-response" } },
    });
  });

  it("deduplicates identical work and keeps it alive for a remaining consumer", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const analyze = vi.fn(async ({ signal }: { readonly signal: AbortSignal }) => {
      observedSignal = signal;
      await wait;
      signal.throwIfAborted();
      return { kind: "computed" as const, data: drift, source: "local-canonical" as const };
    });
    const { service } = setup({ analyzer: { analyze } });
    const request: ActivityAnalysisRequest = {
      canonicalActivityId: ACTIVITY_ID,
      sections: ["aerobic-drift"],
    };
    const firstController = new AbortController();
    const first = service.getActivityAnalysis(request, firstController.signal);
    const second = service.getActivityAnalysis(request);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    firstController.abort(new Error("private abort detail"));
    await expect(first).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "unavailable", reason: "cancelled" } },
    });
    expect(observedSignal?.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "computed" } },
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("runs at most two section analyzers concurrently", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const analyze = async <T>(data: T) => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await wait;
      active -= 1;
      return { kind: "computed" as const, data, source: "local-canonical" as const };
    };
    const analyzers: ActivityAnalysisSectionAnalyzers = {
      aerobicDrift: { analyze: async () => analyze(drift) },
      intervals: {
        analyze: async () =>
          analyze({ source: "local-canonical" as const, intervals: [], groups: [] }),
      },
      bestEfforts: {
        analyze: async () =>
          analyze({
            scope: {
              kind: "selected-activity" as const,
              stream: "power" as const,
              durationSeconds: 60,
              tieRule: "earliest-start" as const,
            },
            efforts: [],
          }),
      },
    };
    const service = createActivityAnalysisService({
      activities: { getActivity: async () => activity },
      sources: source(),
      cache: cache(),
      analyzers,
      now: () => Date.parse("1998-07-06T12:00:00.000Z"),
    });
    const result = service.getActivityAnalysis({
      canonicalActivityId: ACTIVITY_ID,
      sections: ["aerobic-drift", "intervals", "best-efforts"],
    });

    await vi.waitFor(() => expect(started).toBe(2));
    expect(maximumActive).toBe(2);
    release();
    await expect(result).resolves.toMatchObject({
      sections: {
        aerobicDrift: { kind: "computed" },
        intervals: { kind: "computed" },
        bestEfforts: { kind: "computed" },
      },
    });
    expect(started).toBe(3);
    expect(maximumActive).toBe(2);
  });

  it("serializes analysis for different activities", async () => {
    const otherActivityId = "d".repeat(64);
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const getActivity = vi.fn(async ({ id }: { readonly id: string }) => ({
      ...activity,
      id,
    }));
    const analyzed: string[] = [];
    const service = createActivityAnalysisService({
      activities: { getActivity },
      sources: source(async ({ canonicalActivityId }) => ({
        kind: "resolved",
        providerActivityId: `provider-${canonicalActivityId.slice(0, 1)}` as never,
        sourceRevision: canonicalActivityId,
      })),
      cache: cache(),
      analyzers: {
        aerobicDrift: {
          async analyze({ activity: selected }) {
            analyzed.push(selected.id);
            if (selected.id === ACTIVITY_ID) await firstWait;
            return { kind: "computed", data: drift, source: "local-canonical" };
          },
        },
      },
      now: () => Date.parse("1998-07-06T12:00:00.000Z"),
    });
    const first = service.getActivityAnalysis({
      canonicalActivityId: ACTIVITY_ID,
      sections: ["aerobic-drift"],
    });
    await vi.waitFor(() => expect(analyzed).toEqual([ACTIVITY_ID]));
    const second = service.getActivityAnalysis({
      canonicalActivityId: otherActivityId,
      sections: ["aerobic-drift"],
    });
    await Promise.resolve();
    expect(getActivity).toHaveBeenCalledOnce();

    releaseFirst();
    await expect(first).resolves.toMatchObject({ activity: { id: ACTIVITY_ID } });
    await expect(second).resolves.toMatchObject({ activity: { id: otherActivityId } });
    expect(analyzed).toEqual([ACTIVITY_ID, otherActivityId]);
  });

  it("discards a computation if the trusted source revision changes", async () => {
    let revision = REVISION;
    const resolver = source(async () => ({
      kind: "resolved",
      providerActivityId: "provider-42" as never,
      sourceRevision: revision,
    }));
    const analyzer: ActivityAnalysisSectionAnalyzer<"aerobicDrift"> = {
      async analyze() {
        revision = "d".repeat(64);
        return { kind: "computed", data: drift, source: "local-canonical" };
      },
    };
    const { service } = setup({ analyzer, resolver });
    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).resolves.toMatchObject({
      revision: REVISION,
      sections: { aerobicDrift: { kind: "unavailable", reason: "temporary-failure" } },
    });
  });

  it("fails closed when the canonical activity no longer exists", async () => {
    const { service } = setup({ activityValue: undefined });
    const missing = createActivityAnalysisService({
      activities: { getActivity: async () => undefined },
      sources: source(),
      cache: cache(),
      now: () => 0,
    });
    await expect(
      missing.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["intervals"],
      }),
    ).rejects.toEqual(new ActivityAnalysisServiceError("activity-not-found"));
    expect(service).toBeDefined();
  });

  it("bounds a stalled activity lookup and releases the activity gate", async () => {
    const otherActivityId = "d".repeat(64);
    const getActivity = vi.fn(({ id }: { readonly id: string }) =>
      id === ACTIVITY_ID
        ? new Promise<CanonicalActivityDetail | undefined>(() => {})
        : Promise.resolve({ ...activity, id }),
    );
    const service = createActivityAnalysisService({
      activities: { getActivity },
      sources: source(async ({ canonicalActivityId }) => ({
        kind: "resolved",
        providerActivityId: "provider-42" as never,
        sourceRevision: canonicalActivityId,
      })),
      cache: cache(),
      analyzers: {
        aerobicDrift: {
          analyze: async () => ({
            kind: "computed",
            data: drift,
            source: "local-canonical",
          }),
        },
      },
      aggregateDeadlineMs: 20,
      now: () => Date.parse("1998-07-06T12:00:00.000Z"),
    });

    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: otherActivityId,
        sections: ["aerobic-drift"],
      }),
    ).resolves.toMatchObject({ activity: { id: otherActivityId } });
    expect(getActivity).toHaveBeenCalledTimes(2);
  });

  it("bounds stalled source resolution before section work starts", async () => {
    const analyze = vi.fn(async () => ({
      kind: "computed" as const,
      data: drift,
      source: "local-canonical" as const,
    }));
    const { service } = setup({
      aggregateDeadlineMs: 20,
      resolver: source(() => new Promise(() => {})),
      analyzer: { analyze },
    });

    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("turns a stalled persistent-cache read into a bounded timeout section", async () => {
    const projectionCache: ActivityAnalysisProjectionRepository = {
      read: () => new Promise(() => {}),
      write: async () => {},
    };
    const analyze = vi.fn(async () => ({
      kind: "computed" as const,
      data: drift,
      source: "local-canonical" as const,
    }));
    const { service } = setup({
      projectionCache,
      aggregateDeadlineMs: 20,
      analyzer: { analyze },
    });

    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "unavailable", reason: "timeout" } },
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("keeps section permits until aborted physical analyzers actually settle", async () => {
    const otherActivityId = "d".repeat(64);
    let releaseDrift!: () => void;
    let releaseIntervals!: () => void;
    const driftWait = new Promise<void>((resolve) => {
      releaseDrift = resolve;
    });
    const intervalsWait = new Promise<void>((resolve) => {
      releaseIntervals = resolve;
    });
    const started: string[] = [];
    const service = createActivityAnalysisService({
      activities: { getActivity: async ({ id }) => ({ ...activity, id }) },
      sources: source(async ({ canonicalActivityId }) => ({
        kind: "resolved",
        providerActivityId: "provider-42" as never,
        sourceRevision: canonicalActivityId,
      })),
      cache: cache(),
      analyzers: {
        aerobicDrift: {
          async analyze({ activity: selected }) {
            started.push(`drift:${selected.id}`);
            if (selected.id === ACTIVITY_ID) await driftWait;
            return { kind: "computed", data: drift, source: "local-canonical" };
          },
        },
        intervals: {
          async analyze({ activity: selected }) {
            started.push(`intervals:${selected.id}`);
            await intervalsWait;
            return {
              kind: "computed",
              data: { source: "local-canonical", intervals: [], groups: [] },
              source: "local-canonical",
            };
          },
        },
      },
      aggregateDeadlineMs: 1_000,
      now: () => Date.parse("1998-07-06T12:00:00.000Z"),
    });
    const controller = new AbortController();
    const first = service.getActivityAnalysis(
      {
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift", "intervals"],
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(started).toHaveLength(2));
    controller.abort();
    await expect(first).resolves.toMatchObject({
      sections: {
        aerobicDrift: { kind: "unavailable", reason: "cancelled" },
        intervals: { kind: "unavailable", reason: "cancelled" },
      },
    });

    const second = service.getActivityAnalysis({
      canonicalActivityId: otherActivityId,
      sections: ["aerobic-drift"],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).not.toContain(`drift:${otherActivityId}`);

    releaseDrift();
    releaseIntervals();
    await expect(second).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "computed" } },
    });
    expect(started).toContain(`drift:${otherActivityId}`);
  });

  it("bounds the post-analysis source revision check", async () => {
    let resolutions = 0;
    const { service } = setup({
      aggregateDeadlineMs: 20,
      resolver: source(async () => {
        resolutions += 1;
        if (resolutions > 1) return new Promise(() => {});
        return {
          kind: "resolved",
          providerActivityId: "provider-42" as never,
          sourceRevision: REVISION,
        };
      }),
    });

    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "unavailable", reason: "timeout" } },
    });
    expect(resolutions).toBe(2);
  });

  it("bounds a stalled persistent-cache write", async () => {
    const write = vi.fn(() => new Promise<void>(() => {}));
    const projectionCache: ActivityAnalysisProjectionRepository = {
      read: async () => undefined,
      write,
    };
    const { service } = setup({ projectionCache, aggregateDeadlineMs: 20 });

    await expect(
      service.getActivityAnalysis({
        canonicalActivityId: ACTIVITY_ID,
        sections: ["aerobic-drift"],
      }),
    ).resolves.toMatchObject({
      sections: { aerobicDrift: { kind: "unavailable", reason: "timeout" } },
    });
    expect(write).toHaveBeenCalledOnce();
  });
});
