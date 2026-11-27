import { describe, expect, it } from "vitest";
import { addDays, rowStart, weekdayOrder } from "../src/calendar/dates";
import {
  calendarRows,
  defaultRange,
  raceWeek,
  rowLabel,
  seasonPhases,
  seasonWeeks,
  shiftRange,
} from "../src/calendar/grid";
import { activity, calendarRead, plan, week, workout } from "./calendar-fixture";

const MONDAY = 19980105;

describe("calendar rows by region", () => {
  it("starts each row on the region's first day", () => {
    const wednesday = 19980107;
    expect(rowStart(wednesday, 1)).toBe(MONDAY);
    expect(rowStart(wednesday, 7)).toBe(19980104);
    expect(rowStart(wednesday, 6)).toBe(19980103);
    expect(weekdayOrder(7)).toEqual([7, 1, 2, 3, 4, 5, 6]);
    expect(weekdayOrder(6)).toEqual([6, 7, 1, 2, 3, 4, 5]);
  });

  it("opens on last week's row, today's row and two more, and moves a week at a time", () => {
    const range = defaultRange(19980114, 1);
    expect(range).toEqual({ firstRowStart: MONDAY, rowCount: 4 });
    expect(shiftRange(range, 1).firstRowStart).toBe(19980112);
    expect(shiftRange(range, -1).firstRowStart).toBe(19971229);
  });
});

describe("the week column", () => {
  const weeks = [week(1, MONDAY), week(2, 19980112), week(3, 19980119)];
  const running = calendarRead(19980114, plan(MONDAY, weeks, []));

  it("labels a row that is one Training Week with its timing", () => {
    const rows = calendarRows(running, { firstRowStart: MONDAY, rowCount: 3 });
    expect(rows.map((row) => rowLabel(row, 19980114))).toMatchObject([
      { kind: "training-week", week: { index: 1 }, timing: "past" },
      { kind: "training-week", week: { index: 2 }, timing: "current" },
      { kind: "training-week", week: { index: 3 }, timing: "future" },
    ]);
  });

  it("marks where each week begins when the Plan starts mid-week", () => {
    const thursday = 19980108;
    const midWeek = calendarRead(
      19980114,
      plan(thursday, [week(1, thursday), week(2, 19980115)], []),
    );
    const rows = calendarRows(midWeek, { firstRowStart: MONDAY, rowCount: 3 });
    expect(rows.map((row) => rowLabel(row, 19980114))).toMatchObject([
      { kind: "week-start", week: { index: 1 } },
      { kind: "crossing", from: 1, to: { index: 2 } },
      { kind: "week-end", week: { index: 2 } },
    ]);
    expect(rows[0]?.days.map((day) => day.place)).toEqual([
      "before-plan",
      "before-plan",
      "before-plan",
      "in-plan",
      "in-plan",
      "in-plan",
      "in-plan",
    ]);
    expect(rows[0]?.days.find((day) => day.weekStarts !== null)?.dateKey).toBe(thursday);
    expect(rows[1]?.days.find((day) => day.weekStarts !== null)?.dateKey).toBe(19980115);
    expect(rows[2]?.days.every((day) => day.weekStarts === null)).toBe(true);
    expect(rows[2]?.days.map((day) => day.place).slice(2, 4)).toEqual(["in-plan", "after-plan"]);
  });

  it("totals Activities by date when there is no Plan", () => {
    const rides = [
      activity("a", MONDAY, { load: 60 }),
      activity("b", 19980107, { durationS: 1_800, load: null }),
    ];
    const rows = calendarRows(calendarRead(19980114, null, rides), {
      firstRowStart: MONDAY,
      rowCount: 3,
    });
    expect(rows.map((row) => rowLabel(row, 19980114))).toEqual([
      { kind: "dates", timing: "past", durationS: 5_700, count: 2, load: 60 },
      { kind: "dates", timing: "current", durationS: 0, count: 0, load: null },
      { kind: "dates", timing: "future", durationS: 0, count: 0, load: null },
    ]);
  });
});

describe("day cells", () => {
  it("shows a ride only once: on its workout when matched or asked, and as an extra otherwise", () => {
    const done = workout(1, MONDAY, {
      outcome: {
        kind: "done-as-planned",
        activityId: "a".repeat(64),
        actualDurationS: 3_700,
      },
    });
    const asked = workout(2, 19980107, {
      outcome: { kind: "is-this-it", matchId: "m", activityId: "b".repeat(64) },
    });
    const kept = workout(3, 19980108, { copy: { kind: "kept-as-yours" } });
    const read = calendarRead(19980114, plan(MONDAY, [week(1, MONDAY)], [done, asked, kept]), [
      activity("a", MONDAY),
      activity("b", 19980107),
      activity("c", 19980109),
    ]);
    const [row] = calendarRows(read, { firstRowStart: MONDAY, rowCount: 1 });
    expect(row?.days.map((day) => [day.workouts.length, day.activities.length])).toEqual([
      [1, 0],
      [0, 0],
      [1, 0],
      [0, 0],
      [0, 1],
      [0, 0],
      [0, 0],
    ]);
  });
});

describe("the season strip", () => {
  it("groups named phases and finds the race week", () => {
    const weeks = [
      week(1, MONDAY, { phase: "Base" }),
      week(2, 19980112, { phase: "Base" }),
      week(3, 19980119, { phase: "Build" }),
      week(4, 19980126, { phase: null }),
    ];
    const season = plan(MONDAY, weeks, [], { targetDateKey: 19980201, currentWeek: 2 });
    expect(seasonPhases(season)).toEqual([
      { text: "Base", firstWeek: 1, lastWeek: 2 },
      { text: "Build", firstWeek: 3, lastWeek: 3 },
    ]);
    expect(raceWeek(season)).toBe(4);
    expect(seasonWeeks(season).map((entry) => entry.current)).toEqual([false, true, false, false]);
  });

  it("draws done length for confirmed workouts and leaves removed ones out", () => {
    const weeks = [week(1, MONDAY, { status: { kind: "goes-out", onDateKey: 19971229 } })];
    const season = plan(MONDAY, weeks, [
      workout(1, MONDAY, {
        outcome: { kind: "done-differently", activityId: "a".repeat(64), actualDurationS: 2_400 },
      }),
      workout(2, addDays(MONDAY, 2), { outcome: { kind: "removed-by-you" } }),
      workout(3, addDays(MONDAY, 4)),
    ]);
    expect(seasonWeeks(season)).toEqual([
      {
        week: weeks[0],
        sent: "plan-only",
        current: false,
        bars: [
          { workoutId: season.workouts[0]?.id, plannedS: 3_600, doneS: 2_400 },
          { workoutId: season.workouts[2]?.id, plannedS: 3_600, doneS: 0 },
        ],
      },
    ]);
  });
});
