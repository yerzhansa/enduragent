import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { describe, expect, it } from "vitest";
import { type CreationDraft, type CreationDraftInput } from "../src/creation-draft-builder.js";
import {
  applyScheduleIntent,
  applySupportingEventIntent,
  type SupportingEventIntent,
  type SupportingEventRules,
  planChangeRaceWindow,
  type ScheduleIntent,
} from "../src/plan-change.js";

import type { CommitmentRule } from "../src/commitments.js";
import { readTodayChoice } from "../src/today-choice.js";

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

describe("Inverse Plan Changes", () => {
  const intents: ScheduleIntent[] = [
    { kind: "weekday-duration", day: 1, minutes: 20 },
    { kind: "weekday-unavailable", day: 1 },
    { kind: "hard-weekday", day: 1 },
    { kind: "weekly-duration", hours: 1 },
    { kind: "longest-workout", minutes: 20 },
  ];

  it.each(intents)("restores the exact prior snapshot after $kind", (intent) => {
    const previousDraft = fixture();
    const changed = applyScheduleIntent({ draft: previousDraft, intent, todayDateKey });
    const current = structuredClone(changed.after);
    const result = applyScheduleIntent({
      draft: current,
      previousDraft,
      intent: { kind: "inverse", changeId: "applied-change" },
      todayDateKey,
    });
    expect(result.after).toEqual(previousDraft);
    expect(result.totals.after).toEqual(changed.totals.before);
    expect(result.totals.before).toEqual(changed.totals.after);
    expect(result.diff).toHaveLength(changed.diff.length);
    for (const row of changed.diff) {
      expect(result.diff.find((inverse) => inverse.workoutId === row.workoutId)).toEqual({
        workoutId: row.workoutId,
        before: row.after,
        after: row.before,
      });
    }
    expect(current).toEqual(changed.after);
    expect(previousDraft).toEqual(fixture());
  });

  it("keeps the current copy when the restored Workout would land before today", () => {
    const previousDraft = fixture();
    const draft = structuredClone(previousDraft);
    const moved = draft.weeks[3].workouts[0];
    moved.date = "1998-09-12";
    const result = applyScheduleIntent({
      draft,
      previousDraft,
      intent: { kind: "inverse", changeId: "applied-change" },
      todayDateKey: 19980908,
    });
    expect(workouts(result.after).find((workout) => workout.id === moved.id)).toEqual(moved);
    expect(result.diff.some((row) => row.workoutId === moved.id)).toBe(false);
  });

  it("keeps current copies of completed, past and pinned Workouts", () => {
    const previousDraft = fixture();
    const { after: draft } = applyScheduleIntent({
      draft: previousDraft,
      intent: { kind: "longest-workout", minutes: 20 },
      todayDateKey,
    });
    draft.weeks[2].workouts[0].pinned = true;
    const completedWorkoutIds = new Set(["w3-long"]);
    const result = applyScheduleIntent({
      draft,
      previousDraft,
      intent: { kind: "inverse", changeId: "applied-change" },
      todayDateKey: 19980831,
      completedWorkoutIds,
    });
    const protectedIds = ["w2-hard", "w2-endurance", "w2-long", "w3-hard", "w3-long"];
    for (const id of protectedIds) {
      expect(workouts(result.after).find((workout) => workout.id === id)).toEqual(
        workouts(draft).find((workout) => workout.id === id),
      );
      expect(result.diff.some((row) => row.workoutId === id)).toBe(false);
    }
    expect(result.diff).toHaveLength(10);
  });

  it("restores removed Workouts dated today or undated and skips protected Workouts", () => {
    const previousDraft = fixture();
    const { after: draft } = applyScheduleIntent({
      draft: previousDraft,
      intent: { kind: "weekday-unavailable", day: 1 },
      todayDateKey,
    });
    previousDraft.weeks[3].workouts[0].pinned = true;
    previousDraft.weeks[4].workouts[0].date = null;
    const result = applyScheduleIntent({
      draft,
      previousDraft,
      intent: { kind: "inverse", changeId: "applied-change" },
      todayDateKey: 19980831,
      completedWorkoutIds: new Set(["w6-hard"]),
    });
    expect(result.diff).toEqual([
      { workoutId: "w3-hard", before: null, after: previousDraft.weeks[2].workouts[0] },
      { workoutId: "w5-hard", before: null, after: previousDraft.weeks[4].workouts[0] },
    ]);
    expect(
      workouts(result.after)
        .filter((workout) => workout.kind === "hard")
        .map((workout) => workout.id),
    ).toEqual(["w1-hard", "w3-hard", "w5-hard"]);
  });

  it("preserves non-mutable Workouts present only in the current snapshot", () => {
    const previousDraft = fixture();
    const draft = structuredClone(previousDraft);
    const base = draft.weeks[1].workouts[0];
    draft.weeks[1].workouts.push(
      { ...base, id: "new-pinned", pinned: true },
      { ...base, id: "new-undated", date: null },
      { ...base, id: "new-past", date: "1998-08-23" },
      { ...base, id: "new-completed" },
      { ...base, id: "new-mutable" },
    );
    const result = applyScheduleIntent({
      draft,
      previousDraft,
      intent: { kind: "inverse", changeId: "applied-change" },
      todayDateKey,
      completedWorkoutIds: new Set(["new-completed"]),
    });
    expect(result.after.weeks[1].workouts.map((workout) => workout.id)).toEqual(
      draft.weeks[1].workouts
        .filter((workout) => workout.id !== "new-mutable" && workout.id !== "new-undated")
        .map((workout) => workout.id),
    );
    expect(result.diff).toEqual([
      { workoutId: "new-undated", before: { ...base, id: "new-undated", date: null }, after: null },
      { workoutId: "new-mutable", before: { ...base, id: "new-mutable" }, after: null },
    ]);
  });

  it("returns no difference when all changed Workouts have passed", () => {
    const previousDraft = fixture();
    const { after: draft } = applyScheduleIntent({
      draft: previousDraft,
      intent: { kind: "longest-workout", minutes: 20 },
      todayDateKey,
    });
    const result = applyScheduleIntent({
      draft,
      previousDraft,
      intent: { kind: "inverse", changeId: "applied-change" },
      todayDateKey: 19980928,
    });
    expect(result.after).toEqual(draft);
    expect(result.diff).toEqual([]);
    expect(result.totals.after).toEqual(result.totals.before);
  });
});

describe("race window protection", () => {
  const goal = { kind: "event", name: "Spring ride", date: "2000-03-03" } as const;
  const window = { start: "2000-02-26", end: "2000-03-03" };
  const workout = {
    date: "2000-02-29",
    minutes: 60,
    kind: "easy",
    power: null,
  } as const;

  it.each([20000225, 20000304])(
    "allows increases when today %s is outside the window",
    (todayDateKey) => {
      expect(
        planChangeRaceWindow({ goal, todayDateKey, diff: [{ before: null, after: workout }] }),
      ).toBeNull();
    },
  );

  it.each([20000226, 20000229, 20000303])(
    "protects the inclusive window on %s across a leap day",
    (todayDateKey) => {
      expect(
        planChangeRaceWindow({ goal, todayDateKey, diff: [{ before: null, after: workout }] }),
      ).toEqual(window);
    },
  );

  it.each(["2000-02-26", "2000-03-03"])("includes a new Workout dated %s", (date) => {
    expect(
      planChangeRaceWindow({
        goal,
        todayDateKey: 20000226,
        diff: [{ before: null, after: { ...workout, date } }],
      }),
    ).toEqual(window);
  });

  it.each(["2000-02-25", "2000-03-04", null])(
    "allows a new Workout dated %s outside the window",
    (date) => {
      expect(
        planChangeRaceWindow({
          goal,
          todayDateKey: 20000226,
          diff: [{ before: null, after: { ...workout, date } }],
        }),
      ).toBeNull();
    },
  );

  it.each([
    { ...workout, minutes: 61 },
    { ...workout, kind: "hard" as const },
    { ...workout, power: 1 },
  ])("refuses a training increase: %j", (after) => {
    expect(
      planChangeRaceWindow({ goal, todayDateKey: 20000226, diff: [{ before: workout, after }] }),
    ).toEqual(window);
  });

  it.each(["endurance", "long", "event"] as const)(
    "detects %s to hard even when duration decreases",
    (kind) => {
      expect(
        planChangeRaceWindow({
          goal,
          todayDateKey: 20000226,
          diff: [
            { before: { ...workout, kind }, after: { ...workout, kind: "hard", minutes: 30 } },
          ],
        }),
      ).toEqual(window);
    },
  );

  it("compares numeric power and treats null as zero", () => {
    const check = (before: number | null, after: number | null) =>
      planChangeRaceWindow({
        goal,
        todayDateKey: 20000226,
        diff: [{ before: { ...workout, power: before }, after: { ...workout, power: after } }],
      });
    expect(check(100, 101)).toEqual(window);
    expect(check(100, 99)).toBeNull();
    expect(check(100, null)).toBeNull();
    expect(check(null, 0)).toBeNull();
  });

  it("allows reductions, removals, unchanged training and fitness Plans", () => {
    expect(
      planChangeRaceWindow({
        goal,
        todayDateKey: 20000226,
        diff: [
          { before: workout, after: { ...workout, minutes: 30 } },
          { before: workout, after: null },
          { before: { ...workout, kind: "hard" }, after: workout },
          { before: workout, after: workout },
        ],
      }),
    ).toBeNull();
    expect(
      planChangeRaceWindow({
        goal: { kind: "fitness", weeks: 4 },
        todayDateKey: 20000226,
        diff: [{ before: null, after: workout }],
      }),
    ).toBeNull();
  });
});

describe("FTP Plan Changes", () => {
  it("sets confirmed FTP only on mutable Workouts and preserves every other field", () => {
    const draft = fixture();
    const original = structuredClone(draft);
    const completedWorkoutIds = new Set(["w2-hard"]);
    const result = applyScheduleIntent({
      draft,
      intent: { kind: "ftp", watts: 235 },
      todayDateKey,
      completedWorkoutIds,
    });
    expect(result.after.ftp).toBe(235);
    expect(result.totals.after).toEqual(result.totals.before);
    expect(result.diff).toHaveLength(14);
    for (const before of workouts(draft)) {
      const after = workouts(result.after).find((workout) => workout.id === before.id);
      if (
        before.pinned ||
        before.date === null ||
        before.date < "1998-08-24" ||
        completedWorkoutIds.has(before.id)
      ) {
        expect(after).toEqual(before);
      } else {
        expect(after).toEqual({
          ...before,
          power: 235,
          guidance: "Use your confirmed FTP of 235 W",
        });
      }
    }
    expect(draft).toEqual(original);
    expect(result.after.outputFingerprint).not.toBe(draft.outputFingerprint);
    const { inputFingerprint: _input, outputFingerprint, ...snapshot } = result.after;
    expect(outputFingerprint).toBe(
      createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    );
  });

  it.each([0, -1, 235.5, 10_000, Infinity, NaN])("rejects invalid FTP %s", (watts) => {
    expect(() => run({ kind: "ftp", watts })).toThrow("Enter 1–9999 whole watts.");
  });

  it.each([null, 210])("restores prior FTP %s and Workout power through an inverse", (watts) => {
    const before = fixture();
    before.ftp = watts;
    for (const workout of workouts(before)) workout.power = watts;
    const corrected = applyScheduleIntent({
      draft: before,
      intent: { kind: "ftp", watts: 235 },
      todayDateKey,
    });
    const restored = applyScheduleIntent({
      draft: corrected.after,
      intent: { kind: "inverse", changeId: "ftp-correction" },
      previousDraft: before,
      todayDateKey,
    });
    expect(restored.after.ftp).toBe(watts);
    expect(restored.after.weeks).toEqual(before.weeks);
    expect(restored.diff).toHaveLength(15);
    expect(
      restored.diff.every((row) => row.before?.power === 235 && row.after?.power === watts),
    ).toBe(true);
  });

  it("includes power-only differences in an inverse", () => {
    const previousDraft = fixture();
    const draft = structuredClone(previousDraft);
    draft.weeks[1].workouts[0].power = 235;
    const result = applyScheduleIntent({
      draft,
      intent: { kind: "inverse", changeId: "power-correction" },
      previousDraft,
      todayDateKey,
    });
    expect(result.diff).toEqual([
      {
        workoutId: "w2-hard",
        before: draft.weeks[1].workouts[0],
        after: previousDraft.weeks[1].workouts[0],
      },
    ]);
  });
});

const eventRules: SupportingEventRules = {
  availability: {
    mode: "fixed",
    usableWeekdays: [1, 2, 3, 4, 5, 6, 7],
    longestWorkoutHours: 2,
    weeklyHoursLimit: 8,
  },
  restriction: { kind: "none" },
  commitments: { kind: "none" },
};
const sourceEvent = {
  providerId: "race-fixture",
  name: "River ride",
  date: "1998-09-02",
  category: "RACE_B" as const,
  sourceRevision: "a".repeat(64),
};
function eventChange(
  intent: SupportingEventIntent,
  draft: CreationDraft = fixture(),
  rules = eventRules,
) {
  return applySupportingEventIntent({
    draft,
    intent,
    rules,
    todayDateKey,
    eventId: "river",
    source: sourceEvent,
  });
}
function eventAdded(role: "Important" | "Training" = "Training") {
  const result = eventChange({
    kind: "supporting-event",
    operation: "add",
    name: "River ride",
    date: "1998-09-02",
    role,
  });
  if (result.status !== "changed") throw new Error(result.explanation);
  return result;
}

describe("Supporting Event Plan Changes", () => {
  it.each(["add", "manual", "source-update"] as const)(
    "rejects %s when the resulting week would contain seven Workouts",
    (operation) => {
      const draft = eventAdded().after;
      const week = draft.weeks[3];
      const template = week.workouts[0];
      while (week.workouts.length < 6) {
        week.workouts.push({ ...template, id: `extra-${week.workouts.length}`, pinned: true });
      }
      const before = structuredClone(draft);
      if (operation === "source-update" && draft.supportingEvents?.[0]) {
        draft.supportingEvents[0].source = {
          kind: "synced",
          providerId: sourceEvent.providerId,
          sourceRevision: sourceEvent.sourceRevision,
        };
      }
      const result = applySupportingEventIntent({
        draft,
        intent:
          operation === "add"
            ? {
                kind: "supporting-event",
                operation,
                name: "Hill ride",
                date: "1998-09-10",
                role: "Training",
              }
            : operation === "manual"
              ? {
                  kind: "supporting-event",
                  operation,
                  eventId: "river",
                  name: "Hill ride",
                  date: "1998-09-10",
                }
              : { kind: "supporting-event", operation, eventId: "river" },
        eventId: "hill",
        source: { ...sourceEvent, date: "1998-09-10" },
        rules: eventRules,
        todayDateKey,
      });
      expect(result).toEqual({
        status: "invalid",
        explanation:
          "A week can hold at most six Workouts. Remove or move one before adding this event.",
      });
      expect(draft.weeks).toEqual(before.weeks);
    },
  );

  it("adds a manual event, drops same-day training, and fingerprints its pinned Workout", () => {
    const before = fixture();
    const result = eventAdded();
    expect(result.after.supportingEvents).toEqual([
      {
        id: "river",
        name: "River ride",
        date: "1998-09-02",
        role: "Training",
        source: { kind: "manual" },
      },
    ]);
    expect(workouts(result.after).find((workout) => workout.supportingEventId === "river")).toEqual(
      {
        id: "supporting-event-river",
        name: "River ride",
        date: "1998-09-02",
        kind: "event",
        minutes: 45,
        pinned: true,
        power: null,
        guidance: "Use the accepted event limit",
        supportingEventId: "river",
      },
    );
    expect(result.diff.map((row) => row.workoutId)).toEqual([
      "w3-endurance",
      "supporting-event-river",
    ]);
    expect(result.diff[0].after).toBeNull();
    expect(result.diff[1].before).toBeNull();
    expect(result.after.outputFingerprint).not.toBe(before.outputFingerprint);
    expect(before).toEqual(fixture());
  });

  it("accepts source values on synced add and source-update while preserving the Workout id", () => {
    const added = eventChange({
      kind: "supporting-event",
      operation: "add",
      name: "Old name",
      date: "1998-09-03",
      role: "Training",
      providerId: sourceEvent.providerId,
    });
    if (added.status !== "changed") throw new Error(added.explanation);
    expect(added.after.supportingEvents?.[0]).toEqual({
      id: "river",
      name: sourceEvent.name,
      date: sourceEvent.date,
      role: "Training",
      source: {
        kind: "synced",
        providerId: sourceEvent.providerId,
        sourceRevision: sourceEvent.sourceRevision,
      },
    });
    const updated = applySupportingEventIntent({
      draft: added.after,
      intent: { kind: "supporting-event", operation: "source-update", eventId: "river" },
      todayDateKey,
      rules: eventRules,
      source: {
        ...sourceEvent,
        name: "New river ride",
        date: "1998-09-10",
        sourceRevision: "b".repeat(64),
      },
    });
    if (updated.status !== "changed") throw new Error(updated.explanation);
    expect(updated.after.supportingEvents?.[0]).toMatchObject({
      name: "New river ride",
      date: "1998-09-10",
      source: { sourceRevision: "b".repeat(64) },
    });
    expect(updated.diff.find((row) => row.workoutId === "supporting-event-river")).toMatchObject({
      before: { date: "1998-09-02" },
      after: { id: "supporting-event-river", date: "1998-09-10", name: "New river ride" },
    });
    expect(
      workouts(updated.after).filter((workout) => workout.supportingEventId === "river"),
    ).toHaveLength(1);
  });

  it("corrects manual name and date in place, then removes the event and its Workout", () => {
    const corrected = eventChange(
      {
        kind: "supporting-event",
        operation: "manual",
        eventId: "river",
        name: "Hill ride",
        date: "1998-09-10",
      },
      eventAdded().after,
    );
    if (corrected.status !== "changed") throw new Error(corrected.explanation);
    expect(
      workouts(corrected.after).find((workout) => workout.supportingEventId === "river"),
    ).toMatchObject({ id: "supporting-event-river", name: "Hill ride", date: "1998-09-10" });
    const removed = eventChange(
      { kind: "supporting-event", operation: "remove", eventId: "river" },
      corrected.after,
    );
    if (removed.status !== "changed") throw new Error(removed.explanation);
    expect(removed.after.supportingEvents).toEqual([]);
    expect(removed.diff).toEqual([
      {
        workoutId: "supporting-event-river",
        before: workouts(corrected.after).find((workout) => workout.supportingEventId === "river"),
        after: null,
      },
    ]);
  });

  it("renames metadata only, including synced events", () => {
    const draft = eventAdded().after;
    if (draft.supportingEvents?.[0])
      draft.supportingEvents[0].source = {
        kind: "synced",
        providerId: sourceEvent.providerId,
        sourceRevision: sourceEvent.sourceRevision,
      };
    const result = eventChange(
      { kind: "supporting-event", operation: "name", eventId: "river", name: "My river ride" },
      draft,
    );
    if (result.status !== "changed") throw new Error(result.explanation);
    expect(result.after.supportingEvents?.[0].name).toBe("My river ride");
    expect(result.after.weeks).toEqual(draft.weeks);
    expect(result.diff).toEqual([]);
    expect(result.totals.before).toEqual(result.totals.after);
  });

  it("caps Important event civil weeks across Draft week boundaries, then restores nothing for Training", () => {
    const draft = eventAdded().after;
    for (const workout of workouts(draft)) {
      if (workout.id === "w3-hard") workout.date = "1998-09-03";
      if (workout.id === "w4-hard") workout.date = "1998-09-06";
    }
    const result = eventChange(
      { kind: "supporting-event", operation: "role", eventId: "river", role: "Important" },
      draft,
    );
    if (result.status !== "changed") throw new Error(result.explanation);
    for (const id of ["w3-hard", "w4-hard"])
      expect(workouts(result.after).find((workout) => workout.id === id)).toMatchObject({
        kind: "endurance",
        name: "Endurance ride",
        minutes: 30,
      });
    expect(workouts(result.after).find((workout) => workout.id === "w3-long")?.minutes).toBe(30);
    expect(workouts(result.after).find((workout) => workout.id === "w4-long")?.minutes).toBe(100);
    const training = eventChange(
      { kind: "supporting-event", operation: "role", eventId: "river", role: "Training" },
      result.after,
    );
    if (training.status !== "changed") throw new Error(training.explanation);
    expect(training.after.weeks).toEqual(result.after.weeks);
    expect(training.diff).toEqual([]);
  });

  it("caps event duration to the answered day limit and active restriction", () => {
    const intent = {
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-02",
      role: "Training",
    } as const;
    for (const rules of [
      { ...eventRules, availability: { ...eventRules.availability, longestWorkoutHours: 0.5 } },
      {
        ...eventRules,
        restriction: { kind: "max-duration", hours: 0.5, endDate: "1998-09-02" } as const,
      },
    ]) {
      const result = eventChange(intent, fixture(), rules);
      if (result.status !== "changed") throw new Error(result.explanation);
      expect(
        workouts(result.after).find((workout) => workout.supportingEventId === "river")?.minutes,
      ).toBe(30);
    }
  });

  it("restores the prior Draft through inverse add, remove and date correction", () => {
    for (const [draft, intent] of [
      [
        fixture(),
        {
          kind: "supporting-event",
          operation: "add",
          name: "River ride",
          date: "1998-09-02",
          role: "Training",
        },
      ],
      [eventAdded().after, { kind: "supporting-event", operation: "remove", eventId: "river" }],
      [
        eventAdded().after,
        {
          kind: "supporting-event",
          operation: "manual",
          eventId: "river",
          name: "New name",
          date: "1998-09-10",
        },
      ],
    ] satisfies [CreationDraft, SupportingEventIntent][]) {
      const result = eventChange(intent, draft);
      if (result.status !== "changed") throw new Error(result.explanation);
      const inverse = applyScheduleIntent({
        draft: result.after,
        previousDraft: draft,
        intent: { kind: "inverse", changeId: "change" },
        todayDateKey,
      });
      expect(inverse.after).toEqual(draft);
    }
  });

  it("counts an event added during the race window as an increase", () => {
    const draft = fixture();
    const result = applySupportingEventIntent({
      draft,
      intent: {
        kind: "supporting-event",
        operation: "add",
        name: "Local ride",
        date: "1998-09-24",
        role: "Training",
      },
      eventId: "local",
      rules: eventRules,
      todayDateKey: 19980921,
    });
    if (result.status !== "changed") throw new Error(result.explanation);
    expect(
      planChangeRaceWindow({ goal: draft.goal, todayDateKey: 19980921, diff: result.diff }),
    ).toEqual({ start: "1998-09-21", end: "1998-09-27" });
  });

  it("rejects unknown events, malformed details, invalid roles, outside dates, and Main Goal dates", () => {
    const add = {
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-02",
      role: "Training",
    } as const;
    expect(
      eventChange({ kind: "supporting-event", operation: "remove", eventId: "missing" }),
    ).toEqual({
      status: "invalid",
      explanation: "Choose a Supporting Event already accepted in this Plan.",
    });
    for (const intent of [
      { ...add, name: " " },
      { ...add, date: "1998-02-30" },
    ])
      expect(eventChange(intent)).toEqual({
        status: "invalid",
        explanation: "Enter the event name and exact date.",
      });
    for (const date of ["1998-08-16", "1998-09-28", "1998-09-27"])
      expect(eventChange({ ...add, date })).toEqual({
        status: "invalid",
        explanation: "Choose a Supporting Event inside this Plan span.",
      });
  });

  it("refuses an unavailable weekday or an active no-training restriction", () => {
    const intent = {
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-02",
      role: "Training",
    } as const;
    for (const rules of [
      {
        ...eventRules,
        availability: {
          mode: "fixed",
          longestWorkoutHours: 2,
          weeklyHoursLimit: 8,
          usableWeekdays: [1],
        } as const,
      },
      { ...eventRules, restriction: { kind: "no-training", endDate: "1998-09-02" } as const },
    ])
      expect(eventChange(intent, fixture(), rules)).toEqual({
        status: "invalid",
        explanation: "The event date conflicts with a confirmed training limit.",
      });
  });

  it("refuses manual correction of synced events and source-update of manual events", () => {
    const draft = eventAdded().after;
    expect(
      eventChange(
        { kind: "supporting-event", operation: "source-update", eventId: "river" },
        draft,
      ),
    ).toEqual({
      status: "invalid",
      explanation: "Choose a synchronized Supporting Event already accepted in this Plan.",
    });
    if (draft.supportingEvents?.[0])
      draft.supportingEvents[0].source = {
        kind: "synced",
        providerId: sourceEvent.providerId,
        sourceRevision: sourceEvent.sourceRevision,
      };
    expect(
      eventChange(
        {
          kind: "supporting-event",
          operation: "manual",
          eventId: "river",
          name: "Correction",
          date: "1998-09-03",
        },
        draft,
      ),
    ).toEqual({
      status: "invalid",
      explanation: "Accept synchronized event updates through a fresh source-update preview.",
    });
  });

  it("preserves completed event Workouts through inverse and refuses direct edits", () => {
    const draft = eventAdded().after;
    const completedWorkoutIds = new Set(["supporting-event-river"]);
    const result = applySupportingEventIntent({
      draft,
      intent: { kind: "supporting-event", operation: "remove", eventId: "river" },
      rules: eventRules,
      todayDateKey,
      completedWorkoutIds,
    });
    expect(result).toEqual({
      status: "invalid",
      explanation: "Past or completed event Workouts cannot be changed.",
    });
    const inverse = applyScheduleIntent({
      draft,
      previousDraft: fixture(),
      intent: { kind: "inverse", changeId: "change" },
      todayDateKey,
      completedWorkoutIds,
    });
    expect(
      workouts(inverse.after).find((workout) => workout.supportingEventId === "river"),
    ).toEqual(workouts(draft).find((workout) => workout.supportingEventId === "river"));
    expect(inverse.after.supportingEvents).toEqual(draft.supportingEvents);
  });
});

it("keeps a past moved event in its current week with its accepted metadata during inverse", () => {
  const previousDraft = eventAdded().after;
  const moved = eventChange(
    {
      kind: "supporting-event",
      operation: "manual",
      eventId: "river",
      name: "Early river ride",
      date: "1998-08-27",
    },
    previousDraft,
  );
  if (moved.status !== "changed") throw new Error(moved.explanation);
  const inverse = applyScheduleIntent({
    draft: moved.after,
    previousDraft,
    intent: { kind: "inverse", changeId: "move" },
    todayDateKey: 19980828,
  });
  const linked = workouts(inverse.after).filter((workout) => workout.supportingEventId === "river");
  expect(linked).toHaveLength(1);
  expect(linked[0]).toMatchObject({ date: "1998-08-27", name: "Early river ride" });
  expect(inverse.after.weeks[1].workouts).toContainEqual(linked[0]);
  expect(inverse.after.supportingEvents).toEqual(moved.after.supportingEvents);
});

it("does not restore a removed event whose Workout date has passed", () => {
  const previousDraft = eventAdded().after;
  const removed = eventChange(
    { kind: "supporting-event", operation: "remove", eventId: "river" },
    previousDraft,
  );
  if (removed.status !== "changed") throw new Error(removed.explanation);
  const inverse = applyScheduleIntent({
    draft: removed.after,
    previousDraft,
    intent: { kind: "inverse", changeId: "remove" },
    todayDateKey: 19980903,
  });
  expect(inverse.after.supportingEvents).toEqual([]);
  expect(workouts(inverse.after).some((workout) => workout.supportingEventId === "river")).toBe(
    false,
  );
  expect(inverse.diff).toEqual([]);
});

it("leaves past, completed and pinned training unchanged and caps undated training in the event week when an Important event caps the week", () => {
  const draft = fixture();
  draft.weeks[2].workouts.push({
    id: "pinned-training",
    name: "Pinned ride",
    kind: "endurance",
    date: "1998-09-04",
    minutes: 60,
    pinned: true,
    power: null,
    guidance: "Ride comfortably",
  });
  draft.weeks[2].workouts.push({
    id: "undated-training",
    name: "Optional ride",
    kind: "endurance",
    date: null,
    minutes: 60,
    pinned: false,
    power: null,
    guidance: "Ride comfortably",
  });
  const result = applySupportingEventIntent({
    draft,
    intent: {
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-03",
      role: "Important",
    },
    eventId: "river",
    rules: eventRules,
    todayDateKey: 19980901,
    completedWorkoutIds: new Set(["w3-endurance"]),
  });
  if (result.status !== "changed") throw new Error(result.explanation);
  for (const id of ["w3-hard", "w3-endurance", "pinned-training", "event"]) {
    expect(workouts(result.after).find((workout) => workout.id === id)).toEqual(
      workouts(draft).find((workout) => workout.id === id),
    );
  }
  expect(workouts(result.after).find((workout) => workout.id === "w3-long")?.minutes).toBe(30);
  expect(workouts(result.after).find((workout) => workout.id === "undated-training")).toMatchObject(
    { minutes: 30, kind: "endurance", date: null },
  );
});

it("preserves a legacy revision fingerprint when inverse restores its defaulted snapshot", () => {
  const previousDraft = fixture();
  const legacyFingerprint = previousDraft.outputFingerprint;
  previousDraft.supportingEvents = [];
  const changed = applyScheduleIntent({
    draft: previousDraft,
    intent: { kind: "longest-workout", minutes: 20 },
    todayDateKey,
  });
  const inverse = applyScheduleIntent({
    draft: changed.after,
    previousDraft,
    intent: { kind: "inverse", changeId: "legacy-change" },
    todayDateKey,
  });
  expect(inverse.after).toEqual(previousDraft);
  expect(inverse.after.outputFingerprint).toBe(legacyFingerprint);
});

it("undoes a metadata-only rename after the event Workout is completed", () => {
  const previousDraft = eventAdded().after;
  const renamed = eventChange(
    { kind: "supporting-event", operation: "name", eventId: "river", name: "A corrected name" },
    previousDraft,
  );
  if (renamed.status !== "changed") throw new Error(renamed.explanation);
  const linked = workouts(renamed.after).find((workout) => workout.supportingEventId === "river");
  if (linked === undefined) throw new Error("Expected an event Workout");
  const inverse = applyScheduleIntent({
    draft: renamed.after,
    previousDraft,
    intent: { kind: "inverse", changeId: "rename" },
    todayDateKey: 19980903,
    completedWorkoutIds: new Set([linked.id]),
  });
  expect(inverse.diff).toEqual([]);
  expect(inverse.after.supportingEvents).toEqual(previousDraft.supportingEvents);
  expect(workouts(inverse.after).find((workout) => workout.id === linked.id)).toEqual(linked);
});

it("restores undated Workout minutes and kinds after an Important event inverse", () => {
  const draft = fixture();
  draft.mode = "flexible";
  for (const workout of draft.weeks[2].workouts) workout.date = null;
  const result = eventChange(
    {
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-02",
      role: "Important",
    },
    draft,
  );
  if (result.status !== "changed") throw new Error(result.explanation);
  expect(result.after.weeks[2].workouts[0]).toMatchObject({
    date: null,
    minutes: 30,
    kind: "endurance",
  });
  const inverse = applyScheduleIntent({
    draft: result.after,
    previousDraft: draft,
    intent: { kind: "inverse", changeId: "important-add" },
    todayDateKey,
  });
  expect(inverse.after.weeks[2].workouts).toEqual(draft.weeks[2].workouts);
  expect(inverse.after).toEqual(draft);
});

it.each(["mutable", "pinned", "completed"])(
  "restores all undated Workout fields only when %s allows it",
  (state) => {
    const previousDraft = fixture();
    const previous = previousDraft.weeks[1].workouts.find((workout) => workout.id === "undated");
    if (previous === undefined) throw new Error("Expected undated Workout");
    previous.pinned = state === "pinned";
    const draft = structuredClone(previousDraft);
    const present = draft.weeks[1].workouts.find((workout) => workout.id === "undated");
    if (present === undefined) throw new Error("Expected undated Workout");
    Object.assign(present, {
      minutes: 20,
      kind: "endurance",
      name: "Changed ride",
      guidance: "Use power",
      power: 200,
    });
    const inverse = applyScheduleIntent({
      draft,
      previousDraft,
      intent: { kind: "inverse", changeId: "undated-change" },
      todayDateKey,
      completedWorkoutIds: new Set(state === "completed" ? [present.id] : []),
    });
    expect(workouts(inverse.after).find((workout) => workout.id === present.id)).toEqual(
      state === "mutable" ? previous : present,
    );
  },
);

describe("flexible daily choice", () => {
  const answers: Pick<
    CreationDraftInput["answers"],
    "availability" | "restriction" | "commitments"
  > = {
    availability: { mode: "flexible", weeklyHoursLimit: 6, longestWorkoutHours: 2 },
    restriction: { kind: "none" },
    commitments: { kind: "none" },
  };

  function flexibleDraft() {
    const draft = fixture();
    draft.mode = "flexible";
    for (const workout of workouts(draft)) {
      if (!workout.pinned) workout.date = null;
    }
    return draft;
  }

  function choice(restriction: CreationDraftInput["answers"]["restriction"] = { kind: "none" }) {
    return readTodayChoice({
      draft: flexibleDraft(),
      todayDateKey,
      answers: { ...answers, restriction },
    });
  }

  it("offers only undated unpinned and incomplete Workouts in today's week", () => {
    const draft = flexibleDraft();
    draft.weeks[1].workouts[2].pinned = true;
    const result = readTodayChoice({
      draft,
      todayDateKey,
      answers,
      completedWorkoutIds: new Set(["w2-endurance"]),
    });
    expect(result).toEqual({
      date: "1998-08-24",
      eligible: [
        { workoutId: "w2-hard", name: "Controlled effort", minutes: 45, kind: "hard" },
        { workoutId: "undated", name: "Optional ride", minutes: 75, kind: "easy" },
      ],
      blocked: [],
      reason: null,
    });
  });

  it("returns null for fixed mode, another week and no remaining candidates", () => {
    expect(readTodayChoice({ draft: fixture(), todayDateKey, answers })).toBeNull();
    expect(readTodayChoice({ draft: flexibleDraft(), todayDateKey: 19981001, answers })).toBeNull();
    const draft = flexibleDraft();
    draft.weeks[1].workouts = [];
    expect(readTodayChoice({ draft, todayDateKey, answers })).toBeNull();
  });

  it.each([false, true])("prioritizes today's occupied date with closed Plan = %s", (closed) => {
    const draft = flexibleDraft();
    if (!closed) draft.weeks[0].workouts[0].date = "1998-08-24";
    const result = readTodayChoice({
      draft,
      todayDateKey,
      answers: { ...answers, restriction: { kind: "no-training" } },
      occupiedByClosedPlan: closed,
    });
    expect(result?.eligible).toEqual([]);
    expect(result?.reason).toBe("Today already belongs to a dated Workout.");
    expect(result?.blocked).toHaveLength(4);
    expect(result?.blocked.every((item) => item.reason === result.reason)).toBe(true);
  });

  it("blocks every candidate under a current no-training restriction", () => {
    const result = choice({ kind: "no-training", endDate: "1998-08-24" });
    expect(result?.eligible).toEqual([]);
    expect(result?.reason).toBe("Today is unavailable under your confirmed limits.");
    expect(result?.blocked.every((item) => item.reason === result.reason)).toBe(true);
  });

  it.each([
    { kind: "no-training", endDate: "1998-08-23" },
    { kind: "no-hard-training", endDate: "1998-08-23" },
    { kind: "max-duration", hours: 0.5, endDate: "1998-08-23" },
  ] satisfies CreationDraftInput["answers"]["restriction"][])(
    "ignores the expired restriction $kind",
    (restriction) => {
      const result = choice(restriction);
      expect(result?.eligible).toHaveLength(4);
      expect(result?.blocked).toEqual([]);
      expect(result?.reason).toBeNull();
    },
  );

  it("caps today's duration at the lower answered limit and includes the exact boundary", () => {
    const result = choice({ kind: "max-duration", hours: 0.75 });
    expect(result?.eligible.map((workout) => workout.workoutId)).toEqual(["w2-hard"]);
    expect(result?.blocked.map((workout) => workout.reason)).toEqual(
      Array<string>(3).fill("Today is limited to 45 minutes."),
    );
    expect(result?.reason).toBeNull();
    const longest = readTodayChoice({
      draft: flexibleDraft(),
      todayDateKey,
      answers: {
        ...answers,
        availability: { ...answers.availability, longestWorkoutHours: 0.5 },
        restriction: { kind: "max-duration", hours: 1 },
      },
    });
    expect(longest?.eligible).toEqual([]);
    expect(longest?.reason).toBe("Today is limited to 30 minutes.");
  });

  it("blocks hard training after duration checks and permits other kinds", () => {
    const result = choice({ kind: "no-hard-training" });
    expect(result?.blocked).toEqual([
      { workoutId: "w2-hard", name: "Controlled effort", reason: "No hard training today." },
    ]);
    expect(result?.eligible).toHaveLength(3);
    const capped = readTodayChoice({
      draft: flexibleDraft(),
      todayDateKey,
      answers: {
        ...answers,
        availability: { ...answers.availability, longestWorkoutHours: 0.5 },
        restriction: { kind: "no-hard-training" },
      },
    });
    expect(capped?.blocked[0].reason).toBe("Today is limited to 30 minutes.");
    const draft = flexibleDraft();
    draft.weeks[1].workouts = draft.weeks[1].workouts.filter((workout) => workout.kind === "hard");
    expect(
      readTodayChoice({
        draft,
        todayDateKey,
        answers: { ...answers, restriction: { kind: "no-hard-training" } },
      })?.reason,
    ).toBe("No hard training today.");
  });

  it("dates only the selected Workout and restores its null date through the inverse", () => {
    const draft = flexibleDraft();
    const before = structuredClone(draft);
    const result = applyScheduleIntent({
      draft,
      todayDateKey,
      intent: { kind: "choose-workout", workoutId: "w2-hard" },
    });
    expect(result.diff).toEqual([
      {
        workoutId: "w2-hard",
        before: draft.weeks[1].workouts[0],
        after: { ...draft.weeks[1].workouts[0], date: "1998-08-24" },
      },
    ]);
    expect(draft).toEqual(before);
    expect(result.totals.after.plan - result.totals.before.plan).toBe(45);
    const inverse = applyScheduleIntent({
      draft: result.after,
      previousDraft: before,
      todayDateKey,
      intent: { kind: "inverse", changeId: "chosen-workout" },
    });
    expect(inverse.after.weeks).toEqual(before.weeks);
    expect(inverse.diff[0].after?.date).toBeNull();
  });

  it.each(["missing", "w1-hard", "event"])("refuses an unavailable selection %s", (workoutId) => {
    expect(() =>
      applyScheduleIntent({
        draft: flexibleDraft(),
        todayDateKey,
        intent: { kind: "choose-workout", workoutId },
      }),
    ).toThrow("This Workout is no longer eligible.");
  });

  it("counts dating an undated Workout inside the race window as an increase", () => {
    const workout = { date: null, minutes: 45, kind: "easy", power: null } as const;
    expect(
      planChangeRaceWindow({
        goal: { kind: "event", name: "Autumn ride", date: "1998-09-27" },
        todayDateKey: 19980921,
        diff: [{ before: workout, after: { ...workout, date: "1998-09-21" } }],
      }),
    ).toEqual({ start: "1998-09-21", end: "1998-09-27" });
  });
});

it.each([
  { kind: "weekday-unavailable", day: 3 },
  { kind: "time-off", start: "1998-09-01", end: "1998-09-03" },
] satisfies CommitmentRule[])(
  "rejects Supporting Event additions and moves blocked by confirmed $kind",
  (rule) => {
    const rules: SupportingEventRules = {
      ...eventRules,
      commitments: {
        kind: "interpreted",
        text: "Confirmed limits",
        status: "confirmed",
        rules: [rule],
      },
    };
    expect(
      eventChange(
        {
          kind: "supporting-event",
          operation: "add",
          name: "River ride",
          date: "1998-09-02",
          role: "Training",
        },
        fixture(),
        rules,
      ),
    ).toMatchObject({ status: "invalid" });
    const added = eventChange(
      {
        kind: "supporting-event",
        operation: "add",
        name: "River ride",
        date: "1998-09-04",
        role: "Training",
      },
      fixture(),
      rules,
    );
    if (added.status !== "changed") throw new Error(added.explanation);
    expect(
      eventChange(
        {
          kind: "supporting-event",
          operation: "manual",
          eventId: "river",
          name: "River ride",
          date: "1998-09-02",
        },
        added.after,
        rules,
      ),
    ).toMatchObject({ status: "invalid" });
  },
);

it("caps Supporting Events at confirmed weekday duration", () => {
  const result = eventChange(
    {
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-02",
      role: "Training",
    },
    fixture(),
    {
      ...eventRules,
      commitments: {
        kind: "interpreted",
        text: "Wed 30 minutes",
        status: "confirmed",
        rules: [{ kind: "weekday-duration", day: 3, minutes: 30 }],
      },
    },
  );
  if (result.status !== "changed") throw new Error(result.explanation);
  expect(
    workouts(result.after).find((workout) => workout.supportingEventId === "river")?.minutes,
  ).toBe(30);
});

it.each([19980903, 19980910])(
  "keeps a moved event and its Workout in the later week when Undo at %s cannot restore the old date",
  (today) => {
    const previousDraft = eventAdded().after;
    const moved = eventChange(
      {
        kind: "supporting-event",
        operation: "manual",
        eventId: "river",
        name: "Later river ride",
        date: "1998-09-10",
      },
      previousDraft,
    );
    if (moved.status !== "changed") throw new Error(moved.explanation);
    const inverse = applyScheduleIntent({
      draft: moved.after,
      previousDraft,
      intent: { kind: "inverse", changeId: "move" },
      todayDateKey: today,
    });
    const linked = workouts(inverse.after).filter(
      (workout) => workout.supportingEventId === "river",
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ date: "1998-09-10", name: "Later river ride" });
    expect(inverse.after.weeks[3].workouts).toContainEqual(linked[0]);
    expect(
      inverse.after.weeks[2].workouts.some((workout) => workout.supportingEventId === "river"),
    ).toBe(false);
    expect(inverse.after.supportingEvents).toEqual(moved.after.supportingEvents);
    expect(inverse.diff).toEqual([]);
  },
);

it("keeps current metadata when Undo retains a completed event Workout with a corrected name", () => {
  const previousDraft = eventAdded().after;
  const corrected = eventChange(
    {
      kind: "supporting-event",
      operation: "manual",
      eventId: "river",
      name: "Corrected river ride",
      date: "1998-09-02",
    },
    previousDraft,
  );
  if (corrected.status !== "changed") throw new Error(corrected.explanation);
  const linked = workouts(corrected.after).find((workout) => workout.supportingEventId === "river");
  if (!linked) throw new Error("Expected event Workout");
  const inverse = applyScheduleIntent({
    draft: corrected.after,
    previousDraft,
    intent: { kind: "inverse", changeId: "correction" },
    todayDateKey: 19980902,
    completedWorkoutIds: new Set([linked.id]),
  });
  expect(inverse.after.supportingEvents).toEqual(corrected.after.supportingEvents);
  expect(workouts(inverse.after).find((workout) => workout.id === linked.id)).toEqual(linked);
});
