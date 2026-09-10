// `computeDerivedMetrics` runs the metric registry over a MetricInput to
// produce the flat `derived_metrics` object the sync persists. These tests pin
// that (a) it covers the whole registry key-set, (b) it computes real values —
// including the stream-driven DFA-α1 profile — off a golden fixture, and (c) a
// single throwing metric is isolated to `null` + a warning, never sinking the
// rest.

import type { Activity } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";

import {
  computeDerivedMetrics,
  METRIC_COMPUTE_FAILED_LOG_PREFIX,
  POWER_FAMILY_OMIT_KEYS,
} from "../src/reference/sync/compute-derived-metrics.js";
import { METRIC_REGISTRY } from "../src/reference/metrics/registry.js";
import type { MetricInput } from "../src/reference/metrics/metric-input.js";
import {
  buildFixtureShape,
  buildMetricInput,
  type ReferenceBundle,
} from "../src/reference/sync/fixture-bridge.js";
import { runAdaptersForActivities } from "../src/reference/sport-adapter-dispatcher.js";
import {
  composeProvenance,
  readAnalysisBasis,
} from "../src/reference/sync/fetch-reference-data.js";
import type { ReferenceSportAdapter } from "../src/reference/sport-adapter.js";
import type { IntervalsActivityType } from "../src/sport.js";
import { GoldenFixtureSchema, loadFixture } from "./helpers/load-fixture.js";

function dfaEquippedInput(): MetricInput {
  const fixture = loadFixture("golden/dfa-equipped", GoldenFixtureSchema);
  // Anchor frozenNow just after the newest session so the trailing DFA window
  // captures the fixture's sufficient rides (epoch-agnostic).
  const newest = fixture.activities
    .map((a) => a.start_date_local.slice(0, 10))
    .sort()
    .at(-1)!;
  return { fixture, frozenNow: `${newest}T12:00:00` };
}

describe("computeDerivedMetrics", () => {
  it("covers the full registry key-set", () => {
    const out = computeDerivedMetrics(dfaEquippedInput());
    expect(Object.keys(out).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
  });

  it("computes the stream-driven DFA-α1 profile on a real fixture", () => {
    const out = computeDerivedMetrics(dfaEquippedInput());
    const profile = out["capability.dfa_a1_profile"] as {
      latest_session?: { sufficient?: boolean };
      trailing_by_sport?: Record<
        string,
        { aet_estimate?: unknown; aet_crossing_sessions?: number }
      >;
    } | null;
    expect(profile).not.toBeNull();
    expect(profile?.latest_session).toBeDefined();
    expect(profile?.latest_session?.sufficient).toBe(true);
    // The additive 0.75 aerobic-threshold field rides through the production
    // registry path alongside the faithful lt1/lt2 estimates.
    const cycling = profile?.trailing_by_sport?.cycling;
    expect(cycling).toBeDefined();
    expect(cycling).toHaveProperty("aet_estimate");
    expect(typeof cycling?.aet_crossing_sessions).toBe("number");
  });

  it("computes load-management metrics (no throw on real data)", () => {
    const out = computeDerivedMetrics(dfaEquippedInput());
    expect(out).toHaveProperty("acwr");
    expect(out).toHaveProperty("monotony");
    expect(out).toHaveProperty("strain");
  });

  it("does not throw any real registry metric on a deliberately sparse (but schema-valid) fixture", () => {
    // The isolation path should never actually fire for real metrics on thin
    // live data — each degrades to a legitimate null/empty block. A warning here
    // means a real metric throws on sparse input (a production risk).
    const log = vi.fn();
    const sparse = buildFixtureShape({
      activities: [
        {
          id: 1,
          start_date_local: "2026-06-01T07:00:00",
          type: "Ride",
          moving_time: 3600,
          elapsed_time: 3700,
        },
      ],
      wellness: [
        {
          id: "2026-06-01",
          weight: null,
          restingHR: null,
          hrv: null,
          sleepSecs: null,
          sleepQuality: null,
        },
      ],
      ftpHistory: [],
    });
    computeDerivedMetrics({ fixture: sparse, frozenNow: "2026-06-02T12:00:00" }, { log });
    expect(log).not.toHaveBeenCalled();
  });

  it("isolates a throwing metric to null + warning, leaving the rest intact", () => {
    const log = vi.fn();
    const out = computeDerivedMetrics(
      { fixture: {} as never, frozenNow: "x" },
      {
        log,
        registry: {
          good: { compute: () => 42 },
          bad: {
            compute: () => {
              throw new Error("boom");
            },
          },
        },
      },
    );
    expect(out).toEqual({ good: 42, bad: null });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain(METRIC_COMPUTE_FAILED_LOG_PREFIX);
    expect(log.mock.calls[0]?.[0]).toContain("bad");
    expect(log.mock.calls[0]?.[0]).toContain("boom");
  });
});

// ─── Power-family watts-fence (pure-pace omission) ──────────────────────────

const RUNNING_ADAPTER: ReferenceSportAdapter = {
  activityTypes: ["Run", "TrailRun"],
  zoneBasis: "pace",
  decouplingBasis: "pace",
  sustainabilityAnchors: [],
  dfaValidated: false,
  anchorType: "critical-speed",
};

const CYCLING_ADAPTER: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: [300, 1200, 3600],
  dfaValidated: true,
  anchorType: "ftp",
};

const EXCLUDE_FROM_OMISSION = [
  "capability.sustainability_profile",
  "capability.efficiency_factor",
] as const;

// A renamed row carrying the required numeric fields the bridge schema demands
// plus an index signature so it also satisfies the dispatcher's `Activity`.
type TestActivity = ReferenceBundle["activities"][number];

function activity(id: number, type: string, daysAgo: number): TestActivity {
  // Anchor relative to the shared frozenNow so the load windows see the rows.
  const day = String(4 - daysAgo).padStart(2, "0");
  return {
    id,
    start_date_local: `2026-06-${day}T07:00:00`,
    type,
    moving_time: 3600,
    elapsed_time: 3700,
    icu_training_load: 60,
  };
}

function inputFor(activities: readonly TestActivity[]): MetricInput {
  const bundle: ReferenceBundle = {
    activities,
    wellness: [],
    ftpHistory: [],
  };
  return { fixture: buildFixtureShape(bundle), frozenNow: "2026-06-04T12:00:00" };
}

/**
 * Drive the production provenance helper end-to-end: dispatch the activities,
 * derive `omitPowerFamily` + the sibling tag via `composeProvenance`, then run
 * the registry under that fence. The tag is layered OUTSIDE the derived map,
 * exactly as the producer does.
 */
function composeLikeFetchOnce(
  adapters: readonly ReferenceSportAdapter[],
  sportTypes: readonly IntervalsActivityType[],
  activities: readonly TestActivity[],
): {
  derived_metrics: Record<string, unknown>;
  derived_metrics_meta?: {
    sportFamily: string;
    prescriptionBasis: string;
    anchorType: string;
    analysisBasis: "power" | "hr" | "mixed" | null;
  };
  omitPowerFamily: boolean;
} {
  const runs = runAdaptersForActivities(
    adapters,
    sportTypes,
    activities as unknown as readonly Activity[],
  );
  const { omitPowerFamily, meta: baseMeta } = composeProvenance(runs);
  const derived_metrics = computeDerivedMetrics(inputFor(activities), { omitPowerFamily });
  // Fold analysisBasis in post-compute via the same production helper fetchOnce
  // uses, so this test exercises production rather than a hand-copied tag.
  const derived_metrics_meta = baseMeta
    ? { ...baseMeta, analysisBasis: readAnalysisBasis(derived_metrics) }
    : undefined;
  return { derived_metrics, derived_metrics_meta, omitPowerFamily };
}

describe("computeDerivedMetrics power-family omission", () => {
  it("omits exactly the 9 power-family keys when omitPowerFamily is true", () => {
    const out = computeDerivedMetrics(inputFor([activity(1, "Run", 1)]), { omitPowerFamily: true });
    for (const key of POWER_FAMILY_OMIT_KEYS) {
      expect(out).not.toHaveProperty(key);
    }
    const expected = Object.keys(METRIC_REGISTRY).filter((k) => !POWER_FAMILY_OMIT_KEYS.has(k));
    expect(Object.keys(out).sort()).toEqual(expected.sort());
  });

  it("keeps the EXCLUDE-SET (sustainability_profile + efficiency_factor) even when omitting", () => {
    const out = computeDerivedMetrics(inputFor([activity(1, "Run", 1)]), { omitPowerFamily: true });
    for (const key of EXCLUDE_FROM_OMISSION) {
      expect(out).toHaveProperty(key);
    }
  });

  it("DEFAULT (omitPowerFamily unset/false) returns the full registry key-set, byte-identical", () => {
    const noOpts = computeDerivedMetrics(inputFor([activity(1, "Run", 1)]));
    const explicitFalse = computeDerivedMetrics(inputFor([activity(1, "Run", 1)]), {
      omitPowerFamily: false,
    });
    expect(Object.keys(noOpts).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(Object.keys(explicitFalse).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(explicitFalse).toEqual(noOpts);
  });

  it("POWER_FAMILY_OMIT_KEYS has exactly 9 members, excludes the EXCLUDE-SET, and is a registry subset", () => {
    expect(POWER_FAMILY_OMIT_KEYS.size).toBe(9);
    for (const key of EXCLUDE_FROM_OMISSION) {
      expect(POWER_FAMILY_OMIT_KEYS.has(key)).toBe(false);
    }
    for (const key of POWER_FAMILY_OMIT_KEYS) {
      expect(Object.hasOwn(METRIC_REGISTRY, key)).toBe(true);
    }
  });
});

describe("fetchOnce-shaped power-family fence + provenance tag", () => {
  const RUN_TYPES: readonly IntervalsActivityType[] = ["Run", "TrailRun"];
  const RIDE_TYPES: readonly IntervalsActivityType[] = ["Ride", "VirtualRide"];
  const DUATHLON_TYPES: readonly IntervalsActivityType[] = [
    "Ride",
    "VirtualRide",
    "Run",
    "TrailRun",
  ];

  it("pure-Run bundle: omits power keys from derived_metrics and tags run/pace/critical-speed", () => {
    const { derived_metrics, derived_metrics_meta, omitPowerFamily } = composeLikeFetchOnce(
      [RUNNING_ADAPTER],
      RUN_TYPES,
      [activity(1, "Run", 1), activity(2, "TrailRun", 2)],
    );
    expect(omitPowerFamily).toBe(true);
    for (const key of POWER_FAMILY_OMIT_KEYS) {
      expect(derived_metrics).not.toHaveProperty(key);
    }
    // The tag is a SIBLING — no provenance key leaked into the map.
    expect(derived_metrics).not.toHaveProperty("sportFamily");
    expect(derived_metrics).not.toHaveProperty("prescriptionBasis");
    expect(derived_metrics).not.toHaveProperty("anchorType");
    expect(derived_metrics_meta).toEqual({
      sportFamily: "run",
      prescriptionBasis: "pace",
      anchorType: "critical-speed",
      analysisBasis: null,
    });
  });

  it("cycling-only bundle: keeps the full power family and tags cycling/power/ftp", () => {
    const { derived_metrics, derived_metrics_meta, omitPowerFamily } = composeLikeFetchOnce(
      [CYCLING_ADAPTER],
      RIDE_TYPES,
      [activity(1, "Ride", 1)],
    );
    expect(omitPowerFamily).toBe(false);
    expect(Object.keys(derived_metrics).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(derived_metrics_meta).toEqual({
      sportFamily: "cycling",
      prescriptionBasis: "power",
      anchorType: "ftp",
      analysisBasis: null,
    });
  });

  it("mixed Ride+Run bundle: keeps the full power family (duathlete keeps cycling power) and tags", () => {
    const { derived_metrics, derived_metrics_meta, omitPowerFamily } = composeLikeFetchOnce(
      [CYCLING_ADAPTER, RUNNING_ADAPTER],
      DUATHLON_TYPES,
      [activity(1, "Ride", 1), activity(2, "Run", 2)],
    );
    expect(omitPowerFamily).toBe(false);
    expect(Object.keys(derived_metrics).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    for (const key of POWER_FAMILY_OMIT_KEYS) {
      expect(derived_metrics).toHaveProperty(key);
    }
    expect(derived_metrics_meta?.prescriptionBasis).toBe("power");
    expect(derived_metrics_meta?.anchorType).toBe("ftp");
  });

  it("empty-coverage bundle: omitPowerFamily false, full family, no tag", () => {
    const { derived_metrics, derived_metrics_meta, omitPowerFamily } = composeLikeFetchOnce(
      [RUNNING_ADAPTER],
      RUN_TYPES,
      [],
    );
    expect(omitPowerFamily).toBe(false);
    expect(Object.keys(derived_metrics).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(derived_metrics_meta).toBeUndefined();
  });

  it("out-of-sport-only bundle (no covering adapter): omitPowerFamily false, full family", () => {
    const { derived_metrics, omitPowerFamily } = composeLikeFetchOnce(
      [RUNNING_ADAPTER],
      RUN_TYPES,
      [activity(1, "Ride", 1)], // Ride is not covered by the running-only adapter set
    );
    expect(omitPowerFamily).toBe(false);
    expect(Object.keys(derived_metrics).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
  });
});

describe("cycling-shaped survivors on a pure-Run bundle (intentional, wave-3 reader handles)", () => {
  it("consistency_index reads completed=0 / matched=0 via the CYCLING_TYPES gate", () => {
    const out = computeDerivedMetrics(inputFor([activity(1, "Run", 1), activity(2, "Run", 2)]), {
      omitPowerFamily: true,
    });
    const details = out["consistency_details"] as {
      completed_days?: number;
      matched_days?: number;
    } | null;
    expect(details).not.toBeNull();
    expect(details?.completed_days).toBe(0);
    expect(details?.matched_days).toBe(0);
  });

  it("capability.durability survives with null means + the 'power sessions only' note", () => {
    const out = computeDerivedMetrics(inputFor([activity(1, "Run", 1), activity(2, "Run", 2)]), {
      omitPowerFamily: true,
    });
    const durability = out["capability.durability"] as {
      mean_decoupling_7d: number | null;
      mean_decoupling_28d: number | null;
      note: string;
    } | null;
    expect(durability).not.toBeNull();
    expect(durability?.mean_decoupling_7d).toBeNull();
    expect(durability?.mean_decoupling_28d).toBeNull();
    expect(durability?.note).toContain("power sessions only");
  });
});

// ─── running-only golden fixture: watts-fence + run-realism at the TS layer ──
//
// Distinct from the oracle snapshot set (which asserts bit-identity per metric):
// this drives the PRODUCTION pure-pace path — buildMetricInput + the
// `omitPowerFamily: true` watts-fence — over the committed running-only golden
// fixture, then proves the persisted map (a) omits every power-family key and
// (b) populates the run-realism survivors non-degenerately off HR zones.

describe("running-only golden fixture (pure-pace production path)", () => {
  function runningOnlyInput(): MetricInput {
    const fixture = loadFixture("golden/running-only", GoldenFixtureSchema);
    // Map the golden FixtureShape back through the production assembly path
    // (buildMetricInput over a ReferenceBundle) — the same shape the live sync
    // hands the registry for a pure-pace bundle.
    const bundle: ReferenceBundle = {
      activities: fixture.activities,
      wellness: fixture.wellness,
      ftpHistory: fixture.ftp_history,
    };
    return buildMetricInput(bundle, "1998-06-04T12:00:00");
  }

  it("omits all 9 power-family keys under the pure-pace watts-fence", () => {
    const out = computeDerivedMetrics(runningOnlyInput(), { omitPowerFamily: true });
    for (const key of POWER_FAMILY_OMIT_KEYS) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("populates the Seiler-TID / zone-distribution / easy-time survivors non-degenerately off HR zones", () => {
    const out = computeDerivedMetrics(runningOnlyInput(), { omitPowerFamily: true });

    const seiler = out["seiler_tid_7d"] as {
      classification: string | null;
      zone_basis: string | null;
      z1_pct: number | null;
    } | null;
    expect(seiler).not.toBeNull();
    expect(seiler?.classification).not.toBeNull();
    expect(seiler?.zone_basis).toBe("hr");
    expect(seiler?.z1_pct).toBeGreaterThan(0);

    const zoneDist = out["zone_distribution_7d"] as {
      total_hours: number;
      zone_basis: string | null;
    } | null;
    expect(zoneDist).not.toBeNull();
    expect(zoneDist?.zone_basis).toBe("hr");
    expect(zoneDist?.total_hours).toBeGreaterThan(0);

    const easyRatio = out["easy_time_ratio"] as number | null;
    expect(easyRatio).not.toBeNull();
    // Low-intensity-dominant by construction (~0.80).
    expect(easyRatio).toBeGreaterThanOrEqual(0.7);
    expect(easyRatio).toBeLessThanOrEqual(0.9);
  });

  it("provenance tag diverges: prescriptionBasis is pace, analysisBasis is the HR substrate the numbers were computed off", () => {
    // A power-less running bundle is PRESCRIBED off pace/critical-speed but the
    // distribution numbers are ANALYZED off HR zones — the exact mislabel this
    // fix corrects. Derive the tag the production way: run the pace adapter and
    // read the already-computed zone_distribution_7d.zone_basis as the substrate.
    const out = computeDerivedMetrics(runningOnlyInput(), { omitPowerFamily: true });
    const zoneDist = out["zone_distribution_7d"] as { zone_basis: string | null } | null;
    const analysisBasis = zoneDist?.zone_basis ?? null;

    const fixture = loadFixture("golden/running-only", GoldenFixtureSchema);
    const runs = runAdaptersForActivities(
      [RUNNING_ADAPTER],
      ["Run", "TrailRun"],
      fixture.activities as unknown as readonly Activity[],
    );
    const covering = runs.find((r) => r.adapter.zoneBasis === "power")?.adapter ?? runs[0].adapter;

    expect(covering.zoneBasis).toBe("pace");
    expect(analysisBasis).toBe("hr");
  });
});
