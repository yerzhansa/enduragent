import { describe, expect, it } from "vitest";
import { gateLatestJson } from "../src/reference/validation/sync-gate.js";
import type { FetchedReference } from "../src/reference/sync/run-sync.js";
import { emptyFetched } from "./helpers/reference-fixtures.js";

const NOW = new Date("2026-05-09T14:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const isoOffset = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

function withLatest(overrides: Record<string, unknown>): FetchedReference {
  return { ...emptyFetched, latest: { ...emptyFetched.latest, ...overrides } };
}

function withProfile(profile: Record<string, unknown>): FetchedReference {
  return withLatest({ athlete_profile: profile });
}

describe("gateLatestJson", () => {
  it("passes the empty pre-cutover stub clean (every RESOLVE-OR-SKIP branch returns PASS on empty data)", () => {
    const result = gateLatestJson(emptyFetched, null, NOW);
    expect(result).toEqual({ ok: true, failures: [], warnings: [], freshness: "fresh" });
  });

  // ── step0: data fetch (HARD) ──────────────────────────────────────────

  it("step0 PASS: full 5-key envelope → no step0 failure", () => {
    const result = gateLatestJson(emptyFetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step0_data_fetch");
  });

  it("step0 FAIL: routes set null → ok:false, failures contains step0_data_fetch", () => {
    const fetched = { ...emptyFetched, routes: null } as unknown as FetchedReference;
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step0_data_fetch");
  });

  it("step0 FAIL: a non-empty fetch_errors channel → ok:false, step0 failure names the endpoint", () => {
    const fetched: FetchedReference = {
      ...emptyFetched,
      fetch_errors: [{ endpoint: "wellness", detail: "429" }],
    };
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    const step0 = result.failures.find((f) => f.step === "step0_data_fetch");
    expect(step0).toBeDefined();
    expect(step0!.detail).toContain("wellness");
  });

  it("step0 PASS: empty-but-error-free envelope (no fetch_errors) stays green", () => {
    // Guards the errored-vs-empty distinction: a genuinely-empty account must
    // still pass step0 clean. (Same invariant as the :19-22 empty-stub test.)
    const result = gateLatestJson(emptyFetched, null, NOW);
    expect(result.ok).toBe(true);
    expect(result.failures.map((f) => f.step)).not.toContain("step0_data_fetch");
  });

  // ── step1: FTP source (HARD) ──────────────────────────────────────────

  it("step1 PASS: sportSettings ftp:247 → no step1 failure", () => {
    const fetched = withProfile({ sportSettings: [{ types: ["Ride"], ftp: 247 }] });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step1_ftp_source");
  });

  it("step1 FAIL: sportSettings ftp:0 → ok:false, failures contains step1_ftp_source", () => {
    const fetched = withProfile({ sportSettings: [{ types: ["Ride"], ftp: 0 }] });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step1_ftp_source");
  });

  // ── step2: weekly hours consistency (HARD) ────────────────────────────

  it("step2 PASS: weekly_hours=10 + activities summing 10h in 7d → no step2 failure", () => {
    const fetched = withLatest({
      athlete_profile: { quick_stats: { weekly_hours: 10 } },
      recent_activities: [{ start_date_local: isoOffset(-2 * 24 * HOUR_MS), moving_time: 36000 }],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step2_weekly_hours_consistency");
  });

  it("step2 FAIL: weekly_hours=10 + activities summing 5h → ok:false, step2 in failures", () => {
    const fetched = withLatest({
      athlete_profile: { quick_stats: { weekly_hours: 10 } },
      recent_activities: [{ start_date_local: isoOffset(-2 * 24 * HOUR_MS), moving_time: 18000 }],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step2_weekly_hours_consistency");
  });

  it("step2 EDGE: weekly_hours=0 + zero activities → PASS (no divide-by-zero, no NaN)", () => {
    const fetched = withLatest({
      athlete_profile: { quick_stats: { weekly_hours: 0 } },
      recent_activities: [],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(true);
    expect(result.failures.map((f) => f.step)).not.toContain("step2_weekly_hours_consistency");
  });

  it("step2 EDGE: weekly_hours=0 + actualHours=2 → HARD fail (above ABS_FLOOR_HOURS)", () => {
    const fetched = withLatest({
      athlete_profile: { quick_stats: { weekly_hours: 0 } },
      recent_activities: [{ start_date_local: isoOffset(-1 * 24 * HOUR_MS), moving_time: 7200 }],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step2_weekly_hours_consistency");
  });

  // ── step4: tolerance bands (HARD) ─────────────────────────────────────

  it("step4 PASS: weight 70, ftp 247, hr 150 → no step4 failure", () => {
    const fetched = withLatest({
      athlete_profile: { sportSettings: [{ types: ["Ride"], ftp: 247 }] },
      wellness_data: { days: [{ id: "1998-04-11", weight: 70, restingHR: 50 }] },
      recent_activities: [
        {
          start_date_local: isoOffset(-1 * 24 * HOUR_MS),
          moving_time: 3600,
          average_heartrate: 150,
        },
      ],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step4_tolerance_band");
  });

  it("step4 FAIL: weight 500 → ok:false, step4 in failures naming field+value+band", () => {
    const fetched = withLatest({
      wellness_data: { days: [{ id: "1998-04-11", weight: 500, restingHR: 50 }] },
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    const step4 = result.failures.find((f) => f.step === "step4_tolerance_band");
    expect(step4).toBeDefined();
    expect(step4!.detail).toContain("weight=500");
    expect(step4!.detail).toContain("[30,200]");
  });

  // ── step5: CS source (HARD) ───────────────────────────────────────────

  it("step5 PASS: Run row critical_speed:4.0 → no step5 failure", () => {
    const fetched = withProfile({ sportSettings: [{ types: ["Run"], critical_speed: 4.0 }] });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step5_cs_source");
  });

  it("step5 PASS (resolve-or-skip): no Run row → no step5 failure", () => {
    const fetched = withProfile({ sportSettings: [{ types: ["Ride"], ftp: 247 }] });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step5_cs_source");
  });

  it("step5 FAIL: Run row threshold_pace:0 → ok:false, step5 in failures", () => {
    const fetched = withProfile({ sportSettings: [{ types: ["Run"], threshold_pace: 0 }] });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step5_cs_source");
  });

  it("step5 FAIL: Run row threshold_pace:7.5 (>6.5 sanity) → step5 in failures", () => {
    const fetched = withProfile({ sportSettings: [{ types: ["Run"], threshold_pace: 7.5 }] });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step5_cs_source");
  });

  it("step5 FAIL: Run row critical_speed:-1 → step5 in failures", () => {
    const fetched = withProfile({ sportSettings: [{ types: ["Run"], critical_speed: -1 }] });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step5_cs_source");
  });

  it("step5 PASS: manual outranks platform — critical_speed:4.0 valid, threshold_pace:0 ignored", () => {
    const fetched = withProfile({
      sportSettings: [{ types: ["Run"], critical_speed: 4.0, threshold_pace: 0 }],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step5_cs_source");
  });

  it("step5 FAIL: manual present-but-invalid (-1) outranks a valid platform (4.0)", () => {
    const fetched = withProfile({
      sportSettings: [{ types: ["Run"], critical_speed: -1, threshold_pace: 4.0 }],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step5_cs_source");
  });

  it("step5 FAIL: non-finite CS (NaN, Infinity) → step5 in failures", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const fetched = withProfile({ sportSettings: [{ types: ["Run"], critical_speed: bad }] });
      const result = gateLatestJson(fetched, null, NOW);
      expect(result.failures.map((f) => f.step)).toContain("step5_cs_source");
    }
  });

  it("step5 PASS: multiple running rows all sane → no step5 failure", () => {
    const fetched = withProfile({
      sportSettings: [
        { types: ["Run"], critical_speed: 4.0 },
        { types: ["TrailRun"], critical_speed: 3.5 },
      ],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step5_cs_source");
  });

  it("step5 FAIL: multiple running rows, one with critical_speed:0 → step5 in failures", () => {
    const fetched = withProfile({
      sportSettings: [
        { types: ["Run"], critical_speed: 4.0 },
        { types: ["TrailRun"], critical_speed: 0 },
      ],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step5_cs_source");
  });

  // ── step6: freshness (SOFT) ───────────────────────────────────────────

  it("step6 SOFT: data 72h old (via activity date, no server ts) → ok:TRUE, warnings contain step6, freshness 'stale'", () => {
    // Freshness reads the newest activity date when no server `metadata` is
    // present; that path does NOT feed step6b (clock offset), so a stale-but-
    // valid bundle stays ok:true.
    const fetched = withLatest({
      recent_activities: [{ start_date_local: isoOffset(-72 * HOUR_MS), moving_time: 3600 }],
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.step)).toContain("step6_freshness_24h");
    expect(result.freshness).toBe("stale");
  });

  it("step6 PASS: server ts = now → freshness 'fresh', no warning", () => {
    const fetched = withLatest({ metadata: { last_updated: isoOffset(0) } });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.freshness).toBe("fresh");
    expect(result.warnings.map((w) => w.step)).not.toContain("step6_freshness_24h");
  });

  // ── step6b: clock offset (HARD) ───────────────────────────────────────

  it("step6b PASS: server ts within 60min → no step6b failure", () => {
    const fetched = withLatest({ metadata: { last_updated: isoOffset(-30 * 60 * 1000) } });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures.map((f) => f.step)).not.toContain("step6b_clock_offset");
  });

  it("step6b FAIL: server ts = now+90min → ok:false, step6b in failures", () => {
    const fetched = withLatest({ metadata: { last_updated: isoOffset(90 * 60 * 1000) } });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step6b_clock_offset");
  });

  // ── step7: multi-metric conflict (SOFT) ───────────────────────────────

  it("step7 SOFT: weeklyHours>0 & weeklyLoad=0 → ok:TRUE, warnings contain step7", () => {
    const fetched = withProfile({ quick_stats: { weekly_hours: 8, weekly_load: 0 } });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.step)).toContain("step7_multi_metric_conflict");
  });

  it("step7 PASS: consistent signals → no warning", () => {
    const fetched = withProfile({ quick_stats: { weekly_hours: 8, weekly_load: 400 } });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.warnings.map((w) => w.step)).not.toContain("step7_multi_metric_conflict");
  });

  // ── composition: hard dominates soft ──────────────────────────────────

  it("MIXED hard+soft: failing step4 AND warning step6 → ok:false (hard dominates), step6 warning still carried", () => {
    const fetched = withLatest({
      recent_activities: [{ start_date_local: isoOffset(-72 * HOUR_MS), moving_time: 3600 }],
      wellness_data: { days: [{ id: "1998-04-11", weight: 500 }] },
    });
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.step)).toContain("step4_tolerance_band");
    expect(result.warnings.map((w) => w.step)).toContain("step6_freshness_24h");
  });
});
