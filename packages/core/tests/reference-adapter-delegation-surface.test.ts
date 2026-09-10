/**
 * Guards the per-sport adapter delegation seam. A per-sport adapter that
 * surfaces a registry-owned metric delegates to the registry compute and
 * projects its output — it must never register a second compute or re-derive.
 *
 * Three surfaces are pinned:
 *   1. The delegation targets (`computeDfaA1Profile`, `computePowerCurveDelta`,
 *      and the `MetricInput` type) are reachable from `@enduragent/core`, so a
 *      downstream adapter can import them without reaching into core internals.
 *   2. The registry key set is byte-identical to the recorded baseline — no new
 *      `capability.*` writer slipped in. Parity-green alone can't prove this: a
 *      redundant entry would ADD a passing case, not fail one.
 *   3. The registry is absent from the grouped public facades used by sports.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { computeDfaA1Profile, computePowerCurveDelta, type MetricInput } from "@enduragent/core";
import * as corePublicApi from "@enduragent/core";
import * as metricsPublicApi from "@enduragent/kernel/reference/metrics";
import { METRIC_REGISTRY } from "@enduragent/kernel/reference/registry";

const REGISTRY_KEYS_BASELINE = [
  "acwr",
  "benchmark_indoor",
  "benchmark_outdoor",
  "capability.dfa_a1_profile",
  "capability.durability",
  "capability.efficiency_factor",
  "capability.hr_curve_delta",
  "capability.hrrc",
  "capability.power_curve_delta",
  "capability.sustainability_profile",
  "capability.tid_comparison",
  "consistency_details",
  "consistency_index",
  "easy_time_ratio",
  "easy_time_ratio_note",
  "effective_monotony",
  "effort_response_signal",
  "eftp",
  "grey_zone_note",
  "grey_zone_percentage",
  "has_intervals",
  "load_recovery_ratio",
  "monotony",
  "monotony_interpretation",
  "multi_sport_detected",
  "p_max",
  "power_model_source",
  "primary_sport_monotony",
  "quality_intensity_note",
  "quality_intensity_percentage",
  "recovery_index",
  "seasonal_context",
  "seiler_tid_28d",
  "seiler_tid_28d_primary",
  "seiler_tid_7d",
  "seiler_tid_7d_primary",
  "strain",
  "stress_tolerance",
  "vo2max",
  "w_prime",
  "w_prime_kj",
  "weight_signal",
  "zone_distribution_7d",
] as const;

describe("Reference adapter delegation surface", () => {
  it("exposes the capability delegation targets from the public barrel", () => {
    expect(typeof computeDfaA1Profile).toBe("function");
    expect(typeof computePowerCurveDelta).toBe("function");
    expectTypeOf<MetricInput>().toMatchTypeOf<{ frozenNow: string }>();
  });
});

describe("registry stays the sole writer of the capability metrics (OP1)", () => {
  it("has no new key beyond the recorded baseline", () => {
    const keys = Object.keys(METRIC_REGISTRY).sort();
    expect(keys).toEqual([...REGISTRY_KEYS_BASELINE]);
  });

  it("does not leak the registry through the public barrel", () => {
    expect("METRIC_REGISTRY" in corePublicApi).toBe(false);
    expect("METRIC_REGISTRY" in metricsPublicApi).toBe(false);
  });
});
