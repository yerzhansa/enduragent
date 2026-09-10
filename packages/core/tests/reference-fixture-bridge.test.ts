// The fixture bridge turns a fetched intervals.icu bundle into the parity
// gate's `FixtureShape` / `MetricInput`. These tests pin that it assembles the
// required rows, attaches optional curve/stream keys only when present (so an
// absent key reproduces the null-block behaviour the snapshot fixtures rely
// on), and round-trips a real golden fixture's stream-bearing shape.

import { describe, expect, it } from "vitest";

import {
  buildFixtureShape,
  buildMetricInput,
  type ReferenceBundle,
} from "../src/reference/sync/fixture-bridge.js";
import type { Activity, FtpHistoryPoint, WellnessDay } from "../src/reference/schemas/inputs.js";
import { GoldenFixtureSchema, loadFixture } from "./helpers/load-fixture.js";

const activity = (over: Partial<Activity> = {}): Activity => ({
  id: 1,
  start_date_local: "2026-06-01T07:00:00",
  type: "Ride",
  moving_time: 3600,
  elapsed_time: 3700,
  ...over,
});

const wellnessRow = (over: Partial<WellnessDay> = {}): WellnessDay => ({
  id: "2026-06-01",
  weight: 70,
  restingHR: 50,
  hrv: 60,
  sleepSecs: 28800,
  sleepQuality: 3,
  ...over,
});

const ftp: FtpHistoryPoint = { date: "2026-06-01", ftp: 250, source: "estimate" };

describe("buildFixtureShape", () => {
  it("assembles the required rows and parses against FixtureSchema", () => {
    const bundle: ReferenceBundle = {
      activities: [activity()],
      wellness: [wellnessRow()],
      ftpHistory: [ftp],
    };
    const fixture = buildFixtureShape(bundle);
    expect(fixture.activities).toHaveLength(1);
    expect(fixture.wellness).toHaveLength(1);
    expect(fixture.ftp_history).toEqual([ftp]);
  });

  it("omits optional curve/stream/athlete keys when the bundle lacks them", () => {
    const fixture = buildFixtureShape({
      activities: [activity()],
      wellness: [wellnessRow()],
      ftpHistory: [],
    });
    expect("streams" in fixture).toBe(false);
    expect("power_curves" in fixture).toBe(false);
    expect("hr_curves" in fixture).toBe(false);
    expect("sustainability_curves" in fixture).toBe(false);
    expect("athlete" in fixture).toBe(false);
  });

  it("attaches optional keys when present", () => {
    const fixture = buildFixtureShape({
      activities: [activity({ id: "90201" })],
      wellness: [wellnessRow()],
      ftpHistory: [],
      streams: { "90201": { dfa_a1: [1, 0.8], heartrate: [140, 145], watts: [200, 210] } },
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 250, indoor_ftp: 240, lthr: 165 }] },
      currentFtpOutdoor: 250,
    });
    expect(fixture.streams).toBeDefined();
    expect(fixture.streams?.["90201"]?.dfa_a1).toEqual([1, 0.8]);
    expect(fixture.athlete?.sportSettings[0]?.ftp).toBe(250);
    expect(fixture.current_ftp_outdoor).toBe(250);
  });

  it("round-trips a real stream-bearing golden fixture", () => {
    const golden = loadFixture("golden/dfa-equipped", GoldenFixtureSchema);
    const rebuilt = buildFixtureShape({
      activities: golden.activities,
      wellness: golden.wellness,
      ftpHistory: golden.ftp_history,
      streams: golden.streams,
    });
    expect(rebuilt.activities).toEqual(golden.activities);
    expect(rebuilt.streams).toEqual(golden.streams);
  });

  it("buildMetricInput wraps the fixture with frozenNow", () => {
    const input = buildMetricInput(
      { activities: [activity()], wellness: [wellnessRow()], ftpHistory: [] },
      "2026-06-09T12:00:00.000Z",
    );
    expect(input.frozenNow).toBe("2026-06-09T12:00:00.000Z");
    expect(input.fixture.activities).toHaveLength(1);
  });
});
