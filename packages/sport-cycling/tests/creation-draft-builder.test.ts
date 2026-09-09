import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  addCivilDays,
  dateKeyFromText,
  inclusiveCivilDays,
  weekdayForDateKey,
} from "@enduragent/kernel/planning";
import { describe, expect, it } from "vitest";
import { buildCreationDraft, type CreationDraftInput } from "../src/creation-draft-builder.js";
import type { CommitmentRule } from "../src/commitments.js";

function input(): CreationDraftInput {
  return {
    today: "1998-08-24",
    ftp: null,
    answers: {
      goal: { kind: "fitness", weeks: 4 },
      availability: { mode: "flexible", weeklyHoursLimit: 6, longestWorkoutHours: 2 },
      startTiming: { kind: "as-soon-as-possible" },
      restriction: { kind: "none" },
      commitments: { kind: "none" },
      baseline: "regular",
      success: { kind: "fitness-choice", choice: "train-consistently" },
    },
  };
}

function build(value: CreationDraftInput) {
  const result = buildCreationDraft(value);
  if (result.kind !== "draft") throw new Error(result.explanation);
  return result;
}

function eventDate(weeks: number) {
  const digits = String(addCivilDays(dateKeyFromText("1998-08-24"), weeks * 7 - 1));
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

describe("creation draft builder", () => {
  it.each([
    { kind: "weekday-duration", day: 1, minutes: 20 },
    { kind: "weekday-unavailable", day: 1 },
    { kind: "hard-weekday", day: 1 },
    { kind: "time-off", start: "1998-08-25", end: "1998-08-26" },
  ] satisfies CommitmentRule[])("fingerprints a confirmed $kind rule", (rule) => {
    const value = input();
    const before = build(value);
    value.answers.commitments = {
      kind: "interpreted",
      text: "Scheduling limits",
      status: "confirmed",
      rules: [rule],
    };
    expect(build(value).inputFingerprint).not.toBe(before.inputFingerprint);
  });

  it("applies weekday caps alongside the tighter duration restriction", () => {
    const value = input();
    value.answers.availability = {
      mode: "fixed",
      weeklyHoursLimit: 6,
      longestWorkoutHours: 2,
      usableWeekdays: [1, 3, 5],
    };
    const before = build(value);
    value.answers.commitments = {
      kind: "interpreted",
      text: "Wednesday max 20 minutes",
      status: "confirmed",
      rules: [{ kind: "weekday-duration", day: 3, minutes: 20 }],
    };
    const after = build(value);
    expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
    expect(after.weeks[0]?.workouts.map(({ minutes }) => minutes)).toEqual([45, 20, 100]);
    value.answers.restriction = { kind: "max-duration", hours: 0.25 };
    expect(build(value).weeks[0]?.workouts.map(({ minutes }) => minutes)).toEqual([15, 15, 15]);
  });

  it("removes unavailable weekdays and includes both time-off boundaries", () => {
    const value = input();
    value.answers.availability = {
      mode: "fixed",
      weeklyHoursLimit: 6,
      longestWorkoutHours: 2,
      usableWeekdays: [1, 3, 5],
    };
    value.answers.commitments = {
      kind: "interpreted",
      text: "Wednesday off. Away 1998-08-28 to 1998-08-31",
      status: "confirmed",
      rules: [
        { kind: "weekday-unavailable", day: 3 },
        { kind: "time-off", start: "1998-08-28", end: "1998-08-31" },
      ],
    };
    const workouts = build(value).weeks.flatMap(({ workouts }) => workouts);
    expect(workouts.map(({ date }) => date)).toContain("1998-08-24");
    expect(workouts.map(({ date }) => date)).toContain("1998-09-04");
    for (const workout of workouts) {
      expect(weekdayForDateKey(dateKeyFromText(workout.date ?? ""))).not.toBe(3);
      const date = workout.date ?? "";
      expect(date < "1998-08-28" || date > "1998-08-31").toBe(true);
    }
  });

  it("softens hard training to endurance only on the confirmed weekday", () => {
    const value = input();
    value.answers.availability = {
      mode: "fixed",
      weeklyHoursLimit: 6,
      longestWorkoutHours: 2,
      usableWeekdays: [1, 3, 5],
    };
    value.answers.commitments = {
      kind: "interpreted",
      text: "No hard on Monday",
      status: "confirmed",
      rules: [{ kind: "hard-weekday", day: 1 }],
    };
    expect(build(value).weeks[0]?.workouts[0]).toMatchObject({
      kind: "endurance",
      name: "Endurance ride",
    });
    value.answers.commitments.rules = [{ kind: "hard-weekday", day: 3 }];
    expect(build(value).weeks[0]?.workouts[0]).toMatchObject({ kind: "hard" });
    value.answers.restriction = { kind: "no-hard-training" };
    expect(build(value).weeks[0]?.workouts[0]).toMatchObject({ kind: "easy" });
  });

  it("keeps unconfirmed rules out of Workouts", () => {
    const value = input();
    const before = build(value);
    value.answers.commitments = {
      kind: "interpreted",
      text: "Monday off",
      status: "clarify",
      rules: [{ kind: "weekday-unavailable", day: 1 }],
    };
    expect(build(value).weeks).toEqual(before.weeks);
  });

  it("respects commitments in a flexible pool and retains a full week off", () => {
    const value = input();
    value.answers.commitments = {
      kind: "interpreted",
      text: "Monday max 20 min. No hard on Tuesday. Away 1998-08-31 to 1998-09-06",
      status: "confirmed",
      rules: [
        { kind: "weekday-duration", day: 1, minutes: 20 },
        { kind: "hard-weekday", day: 2 },
        { kind: "time-off", start: "1998-08-31", end: "1998-09-06" },
      ],
    };
    const draft = build(value);
    expect(draft.weeks[0]?.workouts.map(({ minutes }) => minutes)).toEqual([20, 20, 20]);
    expect(draft.weeks[0]?.workouts[0]).toMatchObject({ kind: "endurance", date: null });
    expect(draft.weeks[1]?.workouts).toEqual([]);
    expect(draft.weeks[2]?.workouts).toHaveLength(3);
  });

  it.each([1, 4, 5, 24, 25])(
    "builds the %i-week Event boundary and retains the Goal date",
    (weeks) => {
      const value = input();
      value.answers.goal = { kind: "event", name: "Autumn ride", date: eventDate(weeks) };
      const draft = build(value);
      expect(draft.computedWeeks).toBe(weeks);
      expect(draft.weeks).toHaveLength(weeks > 24 ? 12 : weeks);
      expect(draft.spanKind).toBe(
        weeks <= 4 ? "Short block" : weeks > 24 ? "Base Plan" : "Event preparation",
      );
      expect(draft.goal).toEqual(value.answers.goal);
      expect(
        draft.weeks.flatMap((week) => week.workouts).filter((workout) => workout.pinned),
      ).toEqual(
        weeks > 24 ? [] : [expect.objectContaining({ kind: "event", date: eventDate(weeks) })],
      );
    },
  );

  it.each([4, 8, 12, 16] as const)("builds %i seven-day Fitness weeks", (weeks) => {
    const value = input();
    value.answers.goal = { kind: "fitness", weeks };
    const draft = build(value);
    expect(draft.spanKind).toBe("Fitness Plan");
    expect(draft.weeks).toHaveLength(weeks);
    for (const week of draft.weeks)
      expect(inclusiveCivilDays(dateKeyFromText(week.start), dateKeyFromText(week.end))).toBe(7);
  });

  it.each([
    [6, 3],
    [6.01, 4],
    [8, 4],
    [8.01, 5],
  ])("uses %i hours for an ordered pool of %i", (hours, count) => {
    const value = input();
    value.answers.availability.weeklyHoursLimit = hours;
    const draft = build(value);
    expect(draft.weeks[0]?.workouts.map((workout) => workout.name)).toEqual(
      [
        "Controlled effort",
        "Endurance ride",
        "Long ride",
        "Optional easy ride",
        "Additional endurance ride",
      ].slice(0, count),
    );
    expect(
      draft.weeks.every(
        (week) =>
          week.workouts.length === count && week.workouts.every((workout) => workout.date === null),
      ),
    ).toBe(true);
  });

  it("selects today when allowed and the earliest later usable date otherwise", () => {
    const value = input();
    expect(build(value).start).toBe(value.today);
    value.answers.availability = {
      mode: "fixed",
      weeklyHoursLimit: 10,
      longestWorkoutHours: 2,
      usableWeekdays: [2, 4, 7],
    };
    const draft = build(value);
    expect(draft.start).toBe("1998-08-25");
    expect(draft.weeks.every((week) => week.workouts.length === 3)).toBe(true);
    for (const workout of draft.weeks.flatMap((week) => week.workouts)) {
      expect(workout.date).not.toBeNull();
      expect([2, 4, 7]).toContain(weekdayForDateKey(dateKeyFromText(workout.date ?? "")) || 7);
    }
    value.answers.startTiming = { kind: "earliest", date: "1998-09-01" };
    expect(build(value).start).toBe("1998-09-01");
    value.answers.startTiming = { kind: "earliest", date: "1998-08-01" };
    expect(build(value).start).toBe("1998-08-25");
  });

  it("caps each Workout and weekly totals and explains dropped Workouts", () => {
    const value = input();
    value.answers.availability.weeklyHoursLimit = 1;
    value.answers.availability.longestWorkoutHours = 0.5;
    const draft = build(value);
    expect(draft.weeks[0]?.workouts.map((workout) => workout.minutes)).toEqual([30, 30]);
    expect(draft.notes).toContain("Long ride removed because no compatible time remains.");
    value.answers.availability = {
      mode: "fixed",
      usableWeekdays: [1],
      weeklyHoursLimit: 6,
      longestWorkoutHours: 2,
    };
    expect(build(value).weeks.every((week) => week.workouts.length === 1)).toBe(true);
  });

  it("applies no-hard and duration restrictions through their inclusive end date", () => {
    const value = input();
    value.answers.restriction = { kind: "no-hard-training", endDate: "1998-08-30" };
    const draft = build(value);
    expect(draft.weeks[0]?.workouts[0]).toMatchObject({ name: "Easy ride", kind: "easy" });
    expect(draft.weeks[1]?.workouts[0]).toMatchObject({ name: "Controlled effort", kind: "hard" });
    value.answers.restriction = { kind: "max-duration", hours: 0.25, endDate: "1998-08-30" };
    expect(build(value).weeks[0]?.workouts.map((workout) => workout.minutes)).toEqual([15, 15, 15]);
    expect(build(value).weeks[1]?.workouts.map((workout) => workout.minutes)).toEqual([
      45, 60, 100,
    ]);
  });

  it("starts after no-training ends on the first usable date in each mode", () => {
    const value = input();
    value.answers.restriction = { kind: "no-training", endDate: "1998-08-26" };
    expect(build(value).start).toBe("1998-08-27");
    value.answers.availability = {
      mode: "fixed",
      weeklyHoursLimit: 6,
      longestWorkoutHours: 2,
      usableWeekdays: [1, 3, 5],
    };
    const draft = build(value);
    expect(draft.start).toBe("1998-08-28");
    expect(draft.weeks[0]?.workouts.map((workout) => workout.date)).toEqual([
      "1998-08-28",
      "1998-08-31",
      "1998-09-02",
    ]);
    value.answers.startTiming = { kind: "earliest", date: "1998-08-25" };
    expect(build(value).start).toBe("1998-08-28");
    value.answers.startTiming = { kind: "earliest", date: "1998-08-31" };
    expect(build(value).start).toBe("1998-08-31");
  });

  it("searches exactly 370 dates from the earliest start", () => {
    const value = input();
    value.answers.startTiming = { kind: "earliest", date: "1998-08-31" };
    value.answers.restriction = { kind: "no-training", endDate: "1999-09-03" };
    expect(build(value).start).toBe("1999-09-04");
    value.answers.restriction.endDate = "1999-09-04";
    expect(buildCreationDraft(value)).toEqual({
      kind: "no-workouts",
      explanation:
        "No Workouts fit anywhere in this Plan under your confirmed limits. Edit those limits to continue.",
    });
    value.answers.restriction = { kind: "none" };
    value.answers.availability = {
      mode: "fixed",
      weeklyHoursLimit: 6,
      longestWorkoutHours: 2,
      usableWeekdays: [],
    };
    expect(buildCreationDraft(value).kind).toBe("no-workouts");
  });

  it.each(["fixed", "flexible"] as const)(
    "retains empty %s weeks until the duration restriction ends mid-Plan",
    (mode) => {
      const value = input();
      value.answers.availability =
        mode === "fixed"
          ? { mode, weeklyHoursLimit: 6, longestWorkoutHours: 2, usableWeekdays: [1, 3, 5] }
          : { mode, weeklyHoursLimit: 6, longestWorkoutHours: 2 };
      value.answers.restriction = { kind: "max-duration", hours: 0, endDate: "1998-09-06" };
      const draft = build(value);
      expect(draft.start).toBe(value.today);
      expect(draft.weeks.map((week) => week.workouts.length)).toEqual([0, 0, 3, 3]);
      for (const week of draft.weeks.slice(0, 2))
        expect(week.notes).toContain("Confirmed limits leave no Workouts in this week.");
    },
  );

  it("rejects an entirely empty Plan without constructing a Draft", () => {
    const value = input();
    value.answers.restriction = { kind: "no-training" };
    expect(buildCreationDraft(value)).toEqual({
      kind: "no-workouts",
      explanation:
        "No Workouts fit anywhere in this Plan under your confirmed limits. Edit those limits to continue.",
    });
    value.answers.restriction = { kind: "none" };
    value.answers.goal = { kind: "event", name: "Autumn ride", date: "1998-08-23" };
    expect(buildCreationDraft(value)).toEqual({
      kind: "no-workouts",
      explanation: "Choose an event date on or after the Plan start.",
    });
  });

  it.each(["fixed", "flexible"] as const)(
    "pins the Event before %s templates even on an unusable weekday",
    (mode) => {
      const value = input();
      value.answers.goal = { kind: "event", name: "Autumn ride", date: "1998-08-25" };
      value.answers.availability =
        mode === "fixed"
          ? { mode, weeklyHoursLimit: 1.5, longestWorkoutHours: 2, usableWeekdays: [1] }
          : { mode, weeklyHoursLimit: 1.5, longestWorkoutHours: 2 };
      const draft = build(value);
      expect(draft.weeks[0]?.workouts).toMatchObject([
        { date: "1998-08-25", kind: "event", minutes: 60, pinned: true },
        { minutes: 30 },
      ]);
    },
  );

  it("uses civil weeks across leap day and rejects sub-minute capacity", () => {
    const value = input();
    value.today = "2000-02-28";
    expect(build(value).weeks[0]).toMatchObject({ start: "2000-02-28", end: "2000-03-05" });
    value.answers.availability.weeklyHoursLimit = 0.01;
    value.answers.availability.longestWorkoutHours = 0.01;
    expect(buildCreationDraft(value).kind).toBe("no-workouts");
  });

  it("is deterministic, keeps input unchanged, hashes canonical snapshots and invents no power", () => {
    const value = input();
    value.answers.commitments = {
      kind: "interpreted",
      text: "Sunday off",
      rules: [{ kind: "weekday-unavailable", day: 7 }],
      status: "confirmed",
    };
    const original = structuredClone(value);
    const first = build(value);
    const second = build(value);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(value).toEqual(original);
    const { inputFingerprint, outputFingerprint, ...snapshot } = first;
    expect(inputFingerprint).toBe(createHash("sha256").update(canonicalJson(value)).digest("hex"));
    expect(outputFingerprint).toBe(
      createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    );
    expect(first.notes.join(" ")).not.toContain("not been applied");
    for (const workout of first.weeks.flatMap((week) => week.workouts))
      expect(workout).toMatchObject({
        power: null,
        guidance: "Use comfortable perceived effort or your known heart-rate guidance",
      });
  });
});
