import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { describe, expect, it } from "vitest";
import { type CreationDraft } from "../src/creation-draft-builder.js";
import { applyScheduleIntent, type ScheduleIntent } from "../src/plan-change.js";

const todayDateKey = 19980824;

function fixture() {
  const dates = [
    ["1998-08-17", "1998-08-19", "1998-08-22", "1998-08-23"],
    ["1998-08-24", "1998-08-26", "1998-08-29", "1998-08-30"],
    ["1998-08-31", "1998-09-02", "1998-09-05", "1998-09-06"],
    ["1998-09-07", "1998-09-09", "1998-09-12", "1998-09-13"],
    ["1998-09-14", "1998-09-16", "1998-09-19", "1998-09-20"],
    ["1998-09-21", "1998-09-23", "1998-09-26", "1998-09-27"],
  ];
  const draft: CreationDraft & { answeredSummaries: [] } = {
    kind: "draft",
    answeredSummaries: [],
    goal: { kind: "event", name: "Autumn ride", date: "1998-09-27" },
    mode: "fixed",
    start: "1998-08-17",
    end: "1998-09-27",
    spanKind: "Event preparation",
    computedWeeks: 6,
    weeks: dates.map(([start, middle, last, end], index) => ({
      number: index + 1,
      start,
      end,
      notes: [],
      workouts: [
        {
          id: `w${index + 1}-hard`,
          name: "Controlled effort",
          kind: "hard",
          date: start,
          minutes: 45,
          pinned: false,
          guidance: "Use perceived effort",
          power: null,
        },
        {
          id: `w${index + 1}-endurance`,
          name: "Endurance ride",
          kind: "endurance",
          date: middle,
          minutes: 60,
          pinned: false,
          guidance: "Ride comfortably",
          power: null,
        },
        {
          id: `w${index + 1}-long`,
          name: "Long ride",
          kind: "long",
          date: last,
          minutes: 100,
          pinned: false,
          guidance: "Keep it steady",
          power: null,
        },
      ],
    })),
    notes: [],
    guidance: "Use perceived effort",
    ftp: null,
    builderId: "cycling-creation-draft",
    builderVersion: "1",
    inputFingerprint: "0".repeat(64),
    outputFingerprint: "0".repeat(64),
  };
  draft.weeks[1].workouts.push({
    id: "undated",
    name: "Optional ride",
    kind: "easy",
    date: null,
    minutes: 75,
    pinned: false,
    guidance: "Ride comfortably",
    power: null,
  });
  draft.weeks[5].workouts.push({
    id: "event",
    name: "Autumn ride",
    kind: "event",
    date: "1998-09-27",
    minutes: 60,
    pinned: true,
    guidance: "Follow the event limit",
    power: null,
  });
  const { inputFingerprint: _input, outputFingerprint: _output, ...snapshot } = draft;
  draft.outputFingerprint = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  return draft;
}

function workouts(draft: CreationDraft) {
  return draft.weeks.flatMap((week) => week.workouts);
}

function run(intent: ScheduleIntent) {
  return applyScheduleIntent({ draft: fixture(), intent, todayDateKey });
}

describe("Schedule Plan Changes", () => {
  it("caps the selected weekday including today and leaves other weekdays unchanged", () => {
    const result = run({ kind: "weekday-duration", day: 1, minutes: 30 });
    expect(result.diff.map((row) => row.workoutId)).toEqual([
      "w2-hard",
      "w3-hard",
      "w4-hard",
      "w5-hard",
      "w6-hard",
    ]);
    expect(
      result.diff.every((row) => row.before?.minutes === 45 && row.after?.minutes === 30),
    ).toBe(true);
    expect(result.totals.before.plan).toBe(1290);
    expect(result.totals.after.plan).toBe(1215);
  });

  it("removes the selected weekday with null after sides", () => {
    const result = run({ kind: "weekday-unavailable", day: 3 });
    expect(result.diff.map((row) => row.workoutId)).toEqual([
      "w2-endurance",
      "w3-endurance",
      "w4-endurance",
      "w5-endurance",
      "w6-endurance",
    ]);
    expect(result.diff.every((row) => row.after === null)).toBe(true);
    expect(result.totals.after.plan).toBe(990);
  });

  it("replaces hard training with an easy ride of the same duration", () => {
    const result = run({ kind: "hard-weekday", day: 1 });
    expect(result.diff).toHaveLength(5);
    for (const row of result.diff) {
      expect(row.after).toEqual({ ...row.before, kind: "easy", name: "Easy ride" });
    }
    expect(result.totals.after).toEqual(result.totals.before);
  });

  it("trims weeks from the last mutable Workout backwards and stops at 15 minutes", () => {
    const result = run({ kind: "weekly-duration", hours: 3 });
    expect(
      result.after.weeks.map((week) => week.workouts.find((w) => w.kind === "long")?.minutes),
    ).toEqual([100, 75, 75, 75, 75, 15]);
    expect(result.totals.after.weeks).toEqual(
      [205, 180, 180, 180, 180, 180].map((minutes, index) => ({ number: index + 1, minutes })),
    );
    expect(result.totals.after.plan).toBe(1105);
  });

  it.each([
    { hours: 2.25, minutes: 135 },
    { hours: 2.749, minutes: 164 },
  ])("converts a $hours hour weekly budget to $minutes whole minutes", ({ hours, minutes }) => {
    const result = run({ kind: "weekly-duration", hours });
    expect(result.totals.after.weeks.map((week) => week.minutes)).toEqual([
      205,
      ...Array<number>(5).fill(minutes),
    ]);
    expect(
      result.diff.every((row) => row.after === null || Number.isInteger(row.after.minutes)),
    ).toBe(true);
  });

  it("removes a Workout when a weekly trim would leave less than 15 minutes", () => {
    const result = run({ kind: "weekly-duration", hours: 115 / 60 });
    expect(result.diff.find((row) => row.workoutId === "w2-long")?.after).toBeNull();
    expect(result.after.weeks[1].workouts.map((w) => w.id)).toEqual([
      "w2-hard",
      "w2-endurance",
      "undated",
    ]);
    expect(result.totals.after.weeks[1].minutes).toBe(105);
    expect(result.after.weeks[5].workouts.map((w) => [w.id, w.minutes])).toEqual([
      ["w6-hard", 45],
      ["event", 60],
    ]);
  });

  it("keeps protected Workouts even when their week cannot meet the duration limit", () => {
    const result = run({ kind: "weekly-duration", hours: 0.5 });
    expect(result.after.weeks[5].workouts.map((w) => w.id)).toEqual(["event"]);
    expect(result.totals.after.weeks[5].minutes).toBe(60);
  });

  it("caps every eligible Workout for a longest-Workout limit", () => {
    const result = run({ kind: "longest-workout", minutes: 30 });
    expect(result.diff).toHaveLength(15);
    expect(result.diff.every((row) => row.after?.minutes === 30)).toBe(true);
    expect(result.totals.after.plan).toBe(715);
  });

  it("maps Sunday to weekday seven while preserving a pinned Sunday event", () => {
    const draft = fixture();
    draft.weeks[1].workouts[2].date = "1998-08-30";
    const result = applyScheduleIntent({
      draft,
      intent: { kind: "weekday-unavailable", day: 7 },
      todayDateKey,
    });
    expect(result.diff.map((row) => row.workoutId)).toEqual(["w2-long"]);
    expect(workouts(result.after).find((w) => w.id === "event")).toEqual(
      workouts(draft).find((w) => w.id === "event"),
    );
  });

  const intents: ScheduleIntent[] = [
    { kind: "weekday-duration", day: 1, minutes: 20 },
    { kind: "weekday-unavailable", day: 1 },
    { kind: "hard-weekday", day: 1 },
    { kind: "weekly-duration", hours: 1 },
    { kind: "longest-workout", minutes: 20 },
  ];

  it.each(intents)("preserves past, pinned and undated Workouts for $kind", (intent) => {
    const draft = fixture();
    const result = applyScheduleIntent({ draft, intent, todayDateKey });
    const protectedWorkouts = workouts(draft).filter(
      (w) => w.pinned || w.date === null || w.date < "1998-08-24",
    );
    for (const workout of protectedWorkouts) {
      expect(workouts(result.after).find((w) => w.id === workout.id)).toEqual(workout);
      expect(result.diff.some((row) => row.workoutId === workout.id)).toBe(false);
    }
    for (const row of result.diff) {
      if (row.after !== null)
        expect(row.after).toMatchObject({
          id: row.before?.id,
          date: row.before?.date,
          pinned: row.before?.pinned,
          guidance: row.before?.guidance,
        });
    }
    expect(draft).toEqual(fixture());
    expect(result.after.answeredSummaries).toEqual([]);
  });

  it.each(intents)("preserves completed Workouts today for $kind", (intent) => {
    const draft = fixture();
    const completedWorkoutIds = new Set(["w2-hard"]);
    const result = applyScheduleIntent({ draft, intent, todayDateKey, completedWorkoutIds });
    const completed = workouts(draft).find((workout) => workout.id === "w2-hard");
    expect(completed?.date).toBe("1998-08-24");
    expect(workouts(result.after).find((workout) => workout.id === "w2-hard")).toEqual(completed);
    expect(result.diff.some((row) => row.workoutId === "w2-hard")).toBe(false);
    expect(result.diff.length).toBeGreaterThan(0);
    expect(draft).toEqual(fixture());
    expect(completedWorkoutIds).toEqual(new Set(["w2-hard"]));
  });

  it.each(intents)("is deterministic and fingerprints the changed content for $kind", (intent) => {
    const first = run(intent);
    expect(run(intent)).toEqual(first);
    const { inputFingerprint: _input, outputFingerprint, ...snapshot } = first.after;
    expect(outputFingerprint).toBe(
      createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    );
    expect(outputFingerprint).not.toBe(fixture().outputFingerprint);
    expect(first.after.inputFingerprint).toBe(fixture().inputFingerprint);
    const repeat = applyScheduleIntent({ draft: first.after, intent, todayDateKey });
    expect(repeat.after).toEqual(first.after);
    expect(repeat.diff).toEqual([]);
  });

  it("returns an empty diff and identical totals for a no-op intent", () => {
    const result = run({ kind: "longest-workout", minutes: 1440 });
    expect(result.diff).toEqual([]);
    expect(result.after).toEqual(fixture());
    expect(result.totals.after).toEqual(result.totals.before);
    expect(result.totals.before.weeks.map((week) => week.minutes)).toEqual([
      205, 205, 205, 205, 205, 265,
    ]);
  });
});
