// Integration check for the live-data bridge: the composed fetch → bridge →
// registry output (mirroring the production `fetchOnce`) must pass the Layer-1
// sync gate with no hard failures and parse against `LatestJsonSchema` — the
// shape `runSync` commits to `latest.json`. This is the "real adapter output on
// disk stays valid" guarantee behind AC3.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fetchLiveBundle,
  type BundleFetchClient,
} from "../src/reference/sync/fetch-live-bundle.js";
import { buildMetricInput } from "../src/reference/sync/fixture-bridge.js";
import { computeDerivedMetrics } from "../src/reference/sync/compute-derived-metrics.js";
import { runAdaptersForActivities } from "../src/reference/sport-adapter-dispatcher.js";
import {
  composeProvenance,
  readAnalysisBasis,
} from "../src/reference/sync/fetch-reference-data.js";
import type { ReferenceSportAdapter } from "../src/reference/sport-adapter.js";
import type { IntervalsActivityType } from "../src/sport.js";
import type { FetchedReference } from "../src/reference/sync/run-sync.js";
import { gateLatestJson } from "../src/reference/validation/sync-gate.js";
import {
  LatestJsonSchema,
  LATEST_SCHEMA_VERSION,
  type LatestJson,
} from "../src/reference/schemas/latest.js";
import { METRIC_REGISTRY } from "../src/reference/metrics/registry.js";
import { safeReadJson } from "../src/io/safe-read-json.js";

const NOW = new Date("2026-06-09T12:00:00.000Z");

const CYCLING_ADAPTER: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: [300, 1200, 3600],
  dfaValidated: true,
  anchorType: "ftp",
};

const SPORT_TYPES: readonly IntervalsActivityType[] = ["Ride", "VirtualRide"];

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function fakeClient(): BundleFetchClient {
  const activities = Array.from({ length: 5 }, (_, i) => ({
    id: 100 + i,
    startDateLocal: daysAgo(i + 1),
    type: "Ride",
    movingTime: 3600,
    elapsedTime: 3700,
    icuTrainingLoad: 80,
    averageHeartrate: 140,
    icuCtl: 50,
    icuAtl: 60,
  }));
  const wellness = Array.from({ length: 5 }, (_, i) => ({
    id: daysAgo(i + 1).slice(0, 10),
    weight: 70,
    restingHR: 50,
    hrv: 60,
    sleepSecs: 28800,
    sleepQuality: 3,
    ctl: 40,
    atl: 45,
    ctlLoad: 5,
    atlLoad: 6,
    rampRate: 1,
    sportInfo: [{ type: "Ride", eftp: 250 }],
  }));
  return {
    athlete: {
      get: async () => ({
        ok: true,
        value: { sportSettings: [{ types: ["Ride"], ftp: 250, indoor_ftp: 240, lthr: 165 }] },
      }),
    },
    activities: {
      list: async () => ({ ok: true, value: activities }),
      getStreams: async () => ({
        ok: true,
        value: { dfa_a1: [1, 0.8], heartrate: [140, 145], watts: [200, 210] },
      }),
    },
    wellness: { list: async () => ({ ok: true, value: wellness }) },
    events: {
      list: async () => ({
        ok: true,
        value: [
          {
            id: 1,
            category: "WORKOUT",
            startDateLocal: "2026-06-08T08:00:00",
            name: "Past ride",
            type: "Ride",
          },
          {
            id: 2,
            category: "WORKOUT",
            startDateLocal: "2026-06-10T08:00:00",
            name: "Future ride",
            type: "VirtualRide",
          },
          {
            id: 3,
            category: "WORKOUT",
            startDateLocal: "2026-06-10T09:00:00",
            name: "Run",
            type: "Run",
          },
          { id: 4, category: "WORKOUT", startDateLocal: "2026-06-11T09:00:00", name: "Untyped" },
        ],
      }),
    },
  };
}

/** Compose exactly as the production `fetchOnce` does — through the shared
 *  `composeProvenance` helper, so the test exercises the production logic. */
async function composeFetched(): Promise<FetchedReference> {
  const live = await fetchLiveBundle({
    client: fakeClient(),
    signal: new AbortController().signal,
    now: NOW,
    calendarTimeZone: "UTC",
    sportTypes: SPORT_TYPES,
    throttleMs: 0,
  });
  const runs = runAdaptersForActivities([CYCLING_ADAPTER], SPORT_TYPES, live.adapterActivities);
  const { omitPowerFamily, meta: baseMeta } = composeProvenance(runs);
  const derived_metrics = computeDerivedMetrics(buildMetricInput(live.bundle, live.frozenNow), {
    omitPowerFamily,
  });
  const meta = baseMeta
    ? { ...baseMeta, analysisBasis: readAnalysisBasis(derived_metrics) }
    : undefined;
  return {
    latest: {
      athlete_profile: live.athleteProfile,
      current_status: {},
      derived_metrics,
      ...(meta ? { derived_metrics_meta: meta } : {}),
      recent_activities: live.recentActivities,
      planned_workouts: live.plannedWorkouts,
      wellness_data: live.wellnessData,
    },
    history: { daily: [], weekly: [], monthly: [] },
    intervals: { by_activity: {} },
    routes: { routes: [] },
    ftp_history: { entries: [] },
  };
}

describe("live-data bridge integration", () => {
  it("passes the Layer-1 sync gate with no hard failures", async () => {
    const fetched = await composeFetched();
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces a latest envelope that parses against LatestJsonSchema", async () => {
    const fetched = await composeFetched();
    const onDisk = {
      metadata: {
        schema_version: LATEST_SCHEMA_VERSION,
        last_updated: NOW.toISOString(),
        freshness: "fresh" as const,
      },
      ...fetched.latest,
    };
    expect(() => LatestJsonSchema.parse(onDisk)).not.toThrow();
  });

  it("round-trips the derived_metrics_meta tag through the real strict read path (no cache-miss loop)", async () => {
    const fetched = await composeFetched();
    // The fakeClient activities carry no zone-time blocks, so the window-level
    // zone_distribution_7d.zone_basis is null — analysisBasis tracks it (null),
    // distinct from the power prescriptionBasis.
    const tag = {
      sportFamily: "cycling",
      prescriptionBasis: "power",
      anchorType: "ftp",
      analysisBasis: null,
    };
    expect(fetched.latest.derived_metrics_meta).toEqual(tag);

    const onDisk = {
      metadata: {
        schema_version: LATEST_SCHEMA_VERSION,
        last_updated: NOW.toISOString(),
        freshness: "fresh" as const,
      },
      ...fetched.latest,
    };
    const dir = mkdtempSync(join(tmpdir(), "reference-latest-"));
    const path = join(dir, "latest.json");
    writeFileSync(path, JSON.stringify(onDisk), "utf-8");

    const readBack = safeReadJson<LatestJson>(path, LatestJsonSchema);
    expect(readBack).not.toBeNull();
    expect(readBack?.derived_metrics_meta).toEqual(tag);
  });

  it("writes a populated, full-registry derived_metrics block", async () => {
    const fetched = await composeFetched();
    const derived = fetched.latest.derived_metrics as Record<string, unknown>;
    const planned = fetched.latest.planned_workouts as readonly { readonly id: number }[];
    expect(Object.keys(derived).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(fetched.latest.recent_activities.length).toBeGreaterThan(0);
    expect(planned.map((event) => event.id)).toEqual([2]);
    expect(derived.consistency_index).toBe(1);
    expect(derived.consistency_details).toMatchObject({
      planned_days: 1,
      matched_days: 1,
    });
  });

  it("handles an empty bundle (zero activities/wellness): gate passes, full key-set, empty recent_activities", async () => {
    const emptyClient: BundleFetchClient = {
      athlete: { get: async () => ({ ok: true, value: {} }) },
      activities: {
        list: async () => ({ ok: true, value: [] }),
        getStreams: async () => ({ ok: true, value: [] }),
      },
      wellness: { list: async () => ({ ok: true, value: [] }) },
      events: { list: async () => ({ ok: true, value: [] }) },
    };
    const live = await fetchLiveBundle({
      client: emptyClient,
      signal: new AbortController().signal,
      now: NOW,
      calendarTimeZone: "UTC",
      sportTypes: SPORT_TYPES,
      throttleMs: 0,
    });
    runAdaptersForActivities([CYCLING_ADAPTER], SPORT_TYPES, live.adapterActivities);
    const derived_metrics = computeDerivedMetrics(buildMetricInput(live.bundle, live.frozenNow));
    const fetched: FetchedReference = {
      latest: {
        athlete_profile: live.athleteProfile,
        current_status: {},
        derived_metrics,
        recent_activities: live.recentActivities,
        planned_workouts: [],
        wellness_data: live.wellnessData,
      },
      history: { daily: [], weekly: [], monthly: [] },
      intervals: { by_activity: {} },
      routes: { routes: [] },
      ftp_history: { entries: [] },
    };
    expect(gateLatestJson(fetched, null, NOW).failures).toEqual([]);
    expect(Object.keys(derived_metrics).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(live.recentActivities).toEqual([]);
  });
});
