import { describe, expect, it } from "vitest";
import type { AthleteDataReaderPort, AthleteReadResult } from "../src/host-ports.js";
import {
  createCoreToolsWithSportConfig,
  createPureCoreIntervalsTools,
} from "../src/sport/platform-tools.js";

function reader(result: AthleteReadResult<unknown[]>): AthleteDataReaderPort {
  return {
    getAthlete: async () => ({ ok: true, value: {} }),
    listWellness: async () => result,
    listActivities: async () => result,
    getActivity: async () => ({ ok: true, value: {} }),
    getStreams: async () => ({ ok: true, value: {} }),
    listCalendar: async () => ({ ok: true, value: [] }),
    freshness: () => undefined,
  };
}

const range = { oldest: "1998-09-01", newest: "1998-09-08" };
const options = { toolCallId: "projection-test", messages: [] };

describe("intervals list projections", () => {
  it.each([
    { sportInfo: [] },
    { sportInfo: null },
    { sportInfo: undefined },
    { sportInfo: [{ type: "Ride", eftp: 250 }] },
  ])(
    "projects wellness fields and preserves freshness with sportInfo %j",
    async ({ sportInfo }) => {
      const expected = {
        id: "1998-09-08",
        ctl: 40,
        atl: 50,
        rampRate: 0,
        weight: 70,
        restingHR: 48,
        hrv: 65,
        sleepSecs: 28_800,
        sleepScore: 80,
        readiness: 0,
        sleepQuality: 2,
        fatigue: 3,
        stress: 1,
        mood: 2,
        motivation: 3,
        soreness: 0,
        injury: 0,
        ...(sportInfo?.length ? { sportInfo } : {}),
      };
      const row = Object.freeze({
        ...expected,
        sportInfo,
        steps: 5000,
        extra: "unused",
        unusedNull: null,
        unusedUndefined: undefined,
      });
      const sparse = Object.freeze({
        id: "1998-09-07",
        ctl: 0,
        weight: null,
        hrv: undefined,
        rampRate: null,
      });
      const tool = createPureCoreIntervalsTools(
        null,
        "UTC",
        reader({
          ok: true,
          value: [row, sparse],
          freshness: { capturedAt: "1998-09-08T12:00:00", ageMs: 60_000, label: "1 minutes" },
        }),
      ).intervals_fetch_wellness;
      if (!tool?.execute) throw new Error("Wellness tool missing");
      expect(await tool.execute(range, options)).toStrictEqual({
        data: [expected, { id: "1998-09-07", ctl: 0 }],
        freshness: "Store data last synchronized 1 minutes ago (1998-09-08T12:00:00).",
      });
      expect(row.steps).toBe(5000);
      expect(sparse.weight).toBeNull();
    },
  );

  it("projects platform activities to the exact summary keys and drops nulls", async () => {
    const expected = {
      id: "123",
      startDateLocal: "1998-09-08T08:00:00",
      type: "Ride",
      name: "Synthetic ride",
      movingTime: 3600,
      distance: 30_000,
      icuTrainingLoad: 45,
      icuIntensity: 65,
      averageWatts: 150,
      icuWeightedAvgWatts: 160,
      averageHeartrate: 130,
      maxHeartrate: 155,
      icuFtp: 250,
      totalElevationGain: 0,
      source: "GARMIN_CONNECT",
    };
    const row = Object.freeze({ ...expected, description: "unused", calories: null });
    const tool = createCoreToolsWithSportConfig(
      null,
      ["Ride"],
      reader({
        ok: true,
        value: [row, { id: "124", averageWatts: null, maxHeartrate: undefined, distance: 0 }],
      }),
    ).intervals_fetch_activities;
    if (!tool?.execute) throw new Error("Activities tool missing");
    expect(await tool.execute(range, options)).toStrictEqual([
      expected,
      { id: "124", distance: 0 },
    ]);
    expect(row.description).toBe("unused");
  });

  it("preserves canonical activity summaries", async () => {
    const row = {
      id: "a".repeat(64),
      workoutId: "b".repeat(64),
      sessionSequence: 0,
      isMultisport: false,
      sport: "cycling",
      subSport: null,
      isTransition: false,
      startEpochSeconds: 905_241_600,
      timezoneOffsetSeconds: null,
      localDate: "1998-09-08",
      elapsedSeconds: 3600,
      timerSeconds: 3500,
      movingSeconds: null,
      distanceMeters: 30_000,
    };
    const tool = createCoreToolsWithSportConfig(
      null,
      ["Ride"],
      reader({
        ok: true,
        value: [row],
      }),
    ).intervals_fetch_activities;
    if (!tool?.execute) throw new Error("Activities tool missing");
    expect(await tool.execute(range, options)).toStrictEqual([row]);
  });

  it("preserves reader errors for both lists", async () => {
    const failure = {
      ok: false,
      error: "store_read_unavailable",
      message: "Store unavailable",
    } satisfies AthleteReadResult<never>;
    const tools = {
      ...createPureCoreIntervalsTools(null, "UTC", reader(failure)),
      ...createCoreToolsWithSportConfig(null, ["Ride"], reader(failure)),
    };
    for (const tool of [tools.intervals_fetch_wellness, tools.intervals_fetch_activities]) {
      if (!tool?.execute) throw new Error("List tool missing");
      expect(await tool.execute(range, options)).toStrictEqual({
        error: failure.error,
        message: failure.message,
      });
    }
  });
});
