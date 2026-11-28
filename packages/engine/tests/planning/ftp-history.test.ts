import { describe, expect, it } from "vitest";
import {
  bestAveragePower,
  ftpAt,
  ftpChangePercent,
  ftpHistory,
  isFtpTestWorkoutName,
  plannedTestEvidence,
  rideFtpAt,
} from "../../src/planning/ftp-history.js";
import { ftpDriftRun } from "../../src/planning/ftp-proposal.js";
import { addCivilDays } from "@enduragent/kernel/planning";

const DAY = 86_400_000;
const MARCH = Date.parse("1998-03-02T08:00:00.345Z");
const MAY = Date.parse("1998-05-18T08:00:00.120Z");
const JULY = Date.parse("1998-07-13T08:00:00.999Z");

describe("FTP history", () => {
  it("adds a line only when the ride FTP changes, and never dates the first synced FTP", () => {
    const history = ftpHistory(
      [
        { updatedMs: MARCH, ftpWatts: 268, indoorFtpWatts: null },
        { updatedMs: MARCH + DAY, ftpWatts: 268, indoorFtpWatts: null },
        { updatedMs: JULY, ftpWatts: 282, indoorFtpWatts: 274 },
      ],
      [],
    );
    expect(history.ride).toEqual([
      { watts: 268, setAtMs: MARCH, source: "first-sync" },
      { watts: 282, setAtMs: JULY, source: "intervals" },
    ]);
    expect(history.current).toEqual({ watts: 282, setAtMs: JULY, source: "intervals" });
    expect(history.indoor).toEqual([{ watts: 274, setAtMs: JULY, source: "intervals" }]);
  });

  it("keeps the coach's accepted proposal as one line when the next sync brings it back", () => {
    const history = ftpHistory(
      [
        { updatedMs: MARCH, ftpWatts: 268, indoorFtpWatts: null },
        { updatedMs: MAY, ftpWatts: 275, indoorFtpWatts: null },
        { updatedMs: JULY, ftpWatts: 282, indoorFtpWatts: null },
      ],
      [{ watts: 275, setAtMs: MAY, basis: "planned-test", icuUpdatedMs: MAY }],
    );
    expect(history.ride.map((line) => [line.watts, line.source])).toEqual([
      [268, "first-sync"],
      [275, "coach-test"],
      [282, "intervals"],
    ]);
  });

  it("does not hide an athlete's change back to the accepted number after another change", () => {
    const t = Date.parse("1998-03-01T18:00:00.250Z");
    const history = ftpHistory(
      [
        { updatedMs: Date.parse("1998-02-09T08:00:00.100Z"), ftpWatts: 282, indoorFtpWatts: null },
        { updatedMs: t, ftpWatts: 288, indoorFtpWatts: null },
        { updatedMs: t + 5 * 60_000, ftpWatts: 300, indoorFtpWatts: null },
        { updatedMs: t + 10 * 60_000, ftpWatts: 288, indoorFtpWatts: null },
      ],
      [{ watts: 288, setAtMs: t, basis: "drift", icuUpdatedMs: t }],
    );
    expect(history.ride.map((line) => [line.watts, line.source])).toEqual([
      [282, "first-sync"],
      [288, "coach-estimate"],
      [300, "intervals"],
      [288, "intervals"],
    ]);
    expect(history.current?.watts).toBe(288);
  });

  it("matches the echo by time only when intervals.icu gave no update time", () => {
    const history = ftpHistory(
      [
        { updatedMs: MARCH, ftpWatts: 282, indoorFtpWatts: null },
        { updatedMs: JULY + 2_000, ftpWatts: 291, indoorFtpWatts: null },
      ],
      [{ watts: 291, setAtMs: JULY, basis: "drift", icuUpdatedMs: null }],
    );
    expect(history.ride.map((line) => line.source)).toEqual(["first-sync", "coach-estimate"]);
  });

  it("shows the accepted FTP before the sync brings it back", () => {
    const history = ftpHistory(
      [{ updatedMs: MARCH, ftpWatts: 282, indoorFtpWatts: null }],
      [{ watts: 291, setAtMs: JULY, basis: "drift", icuUpdatedMs: JULY }],
    );
    expect(history.current).toEqual({ watts: 291, setAtMs: JULY, source: "coach-estimate" });
  });

  it("keeps the point where the athlete cleared the FTP in intervals.icu", () => {
    const history = ftpHistory(
      [
        { updatedMs: MARCH, ftpWatts: 268, indoorFtpWatts: 260 },
        { updatedMs: MAY, ftpWatts: null, indoorFtpWatts: null },
        { updatedMs: JULY, ftpWatts: 290, indoorFtpWatts: null },
      ],
      [],
    );
    expect(history.ride.map((line) => line.watts)).toEqual([268, 290]);
    expect(ftpAt(history.points, MAY + DAY)?.watts).toBeNull();
    expect(ftpAt(history.points, JULY + DAY)?.watts).toBe(290);
    expect(history.indoor).toEqual([
      { watts: 260, setAtMs: MARCH, source: "first-sync" },
      { watts: null, setAtMs: MAY, source: "intervals" },
    ]);
    expect(
      ftpHistory([{ updatedMs: MAY, ftpWatts: null, indoorFtpWatts: null }], []).current,
    ).toBeNull();
  });
});

describe("the FTP a ride used", () => {
  const history = ftpHistory(
    [
      { updatedMs: Date.parse("1998-01-05T08:00:00.100Z"), ftpWatts: 268, indoorFtpWatts: null },
      { updatedMs: Date.parse("1998-02-09T08:00:00.100Z"), ftpWatts: 282, indoorFtpWatts: 274 },
      { updatedMs: Date.parse("1998-02-20T08:00:00.100Z"), ftpWatts: null, indoorFtpWatts: 274 },
      { updatedMs: Date.parse("1998-02-23T08:00:00.100Z"), ftpWatts: 282, indoorFtpWatts: 274 },
    ],
    [
      {
        watts: 291,
        setAtMs: Date.parse("1998-03-01T18:00:00Z"),
        basis: "drift",
        icuUpdatedMs: null,
      },
    ],
  );

  it("keeps a ride from this morning on the FTP it used after a new FTP in the evening", () => {
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1998-03-01T07:00:00Z"),
        indoor: false,
        appliedWatts: null,
      }),
    ).toMatchObject({ kind: "known", watts: 282, use: "outdoor", line: { source: "intervals" } });
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1998-03-01T19:00:00Z"),
        indoor: false,
        appliedWatts: null,
      }),
    ).toMatchObject({ kind: "known", watts: 291, line: { source: "coach-estimate" } });
  });

  it("uses the FTP intervals.icu applied to the ride, with the line only when it agrees", () => {
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1998-02-10T07:00:00Z"),
        indoor: false,
        appliedWatts: 279,
      }),
    ).toEqual({ kind: "known", watts: 279, use: "outdoor", line: null, outdoorWatts: 282 });
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1997-12-01T07:00:00Z"),
        indoor: false,
        appliedWatts: 255,
      }),
    ).toEqual({ kind: "known", watts: 255, use: "outdoor", line: null, outdoorWatts: null });
  });

  it("knows no FTP before the first synced version or after the FTP was cleared", () => {
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1997-12-01T07:00:00Z"),
        indoor: false,
        appliedWatts: null,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1998-02-21T07:00:00Z"),
        indoor: false,
        appliedWatts: null,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("uses the indoor FTP for an indoor ride and names the outdoor one beside it", () => {
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1998-02-25T07:00:00Z"),
        indoor: true,
        appliedWatts: null,
      }),
    ).toMatchObject({ kind: "known", watts: 274, use: "indoor", outdoorWatts: 282 });
    expect(
      rideFtpAt(history, {
        startMs: Date.parse("1998-01-10T07:00:00Z"),
        indoor: true,
        appliedWatts: null,
      }),
    ).toMatchObject({ kind: "known", watts: 268, use: "outdoor" });
  });

  it("calls an indoor ride outdoor when intervals.icu applied the outdoor FTP to it", () => {
    const indoorSet = ftpHistory([{ updatedMs: MARCH, ftpWatts: 282, indoorFtpWatts: 274 }], []);
    const ride = { startMs: MAY, indoor: true };
    expect(rideFtpAt(indoorSet, { ...ride, appliedWatts: 282 })).toEqual({
      kind: "known",
      watts: 282,
      use: "outdoor",
      line: { watts: 282, setAtMs: MARCH, source: "first-sync" },
      outdoorWatts: 282,
    });
    expect(rideFtpAt(indoorSet, { ...ride, appliedWatts: 274 })).toMatchObject({
      use: "indoor",
      watts: 274,
      line: { watts: 274 },
    });
    expect(rideFtpAt(indoorSet, { ...ride, appliedWatts: 268 })).toMatchObject({
      use: "indoor",
      watts: 268,
      line: null,
    });
  });
});

describe("FTP tests and the estimate", () => {
  it("marks a planned FTP test by its name", () => {
    expect(isFtpTestWorkoutName("FTP test")).toBe(true);
    expect(isFtpTestWorkoutName("20-minute test")).toBe(true);
    expect(isFtpTestWorkoutName("20 min FTP test")).toBe(true);
    expect(isFtpTestWorkoutName("Threshold 4×8")).toBe(false);
  });

  it("proposes 95% of the latest planned test's 20-minute power, ridden after the FTP was set", () => {
    const results = [
      {
        activityId: "a",
        dateKey: 19980501,
        startMs: Date.parse("1998-05-01T07:00:00Z"),
        twentyMinuteWatts: 290,
      },
      {
        activityId: "b",
        dateKey: 19980518,
        startMs: Date.parse("1998-05-18T12:00:00Z"),
        twentyMinuteWatts: 303,
      },
    ];
    expect(plannedTestEvidence([])).toEqual({ kind: "none" });
    expect(plannedTestEvidence(results)).toEqual({
      kind: "planned-test",
      watts: 288,
      activityId: "b",
      dateKey: 19980518,
    });
    expect(plannedTestEvidence(results, { atMs: Date.parse("1998-05-18T12:30:00Z") })).toEqual({
      kind: "none",
    });
    expect(
      plannedTestEvidence(results, { atMs: Date.parse("1998-05-18T06:00:00Z") }),
    ).toMatchObject({ activityId: "b" });
    expect(
      plannedTestEvidence(results, { atMs: Date.parse("1998-05-10T08:00:00Z") }),
    ).toMatchObject({
      activityId: "b",
    });
  });

  it("says how far a new FTP moves every target", () => {
    expect(ftpChangePercent(282, 288)).toBe(2);
    expect(ftpChangePercent(null, 288)).toBeNull();
  });

  it("proposes 1% under the lowest estimate of the last 14 days, rounded down", () => {
    const today = 19980819;
    const samples = Array.from({ length: 15 }, (_, offset) => ({
      dateKey: addCivilDays(today, offset - 14),
      estimatedFtpWatts: offset < 5 ? 291 : 293,
    }));
    expect(
      ftpDriftRun({ ftpWatts: 282, ftpSetDateKey: 19980713, samples, todayDateKey: today }),
    ).toEqual({
      direction: "above",
      sinceDateKey: 19980805,
      lastDateKey: today,
      lowWatts: 291,
      highWatts: 293,
      lowestRecentWatts: 291,
      proposedWatts: 288,
    });
  });
});

describe("best 20-minute power", () => {
  it("averages the best 20 minutes of a ride's power by time", () => {
    const times = Array.from({ length: 3_000 }, (_, index) => index);
    const powers = times.map((second) => (second >= 600 && second < 1_800 ? 300 : 150));
    expect(bestAveragePower(times, powers)).toBe(300);
  });

  it("has no 20-minute power for a shorter ride", () => {
    const times = Array.from({ length: 600 }, (_, index) => index);
    expect(
      bestAveragePower(
        times,
        times.map(() => 250),
      ),
    ).toBeNull();
  });

  it("counts missing power as zero", () => {
    const times = Array.from({ length: 1_201 }, (_, index) => index);
    const powers = times.map((second) => (second < 600 ? 300 : null));
    expect(bestAveragePower(times, powers)).toBe(150);
  });

  it("counts a pause in the recording as zero, not as the last power", () => {
    const time = [
      ...Array.from({ length: 300 }, (_, second) => second),
      ...Array.from({ length: 300 }, (_, second) => 1_200 + second),
    ];
    const watts = time.map((at) => (at < 300 ? 350 : 200));
    const best = bestAveragePower(time, watts);
    expect(best).not.toBeNull();
    expect(best ?? 0).toBeLessThan(150);
  });
});
