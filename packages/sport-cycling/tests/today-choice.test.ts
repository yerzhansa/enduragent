import { describe, expect, it } from "vitest";
import { buildCreationDraft, type CreationDraftInput } from "../src/creation-draft-builder.js";
import type { CommitmentRule } from "../src/commitments.js";
import { readTodayChoice } from "../src/today-choice.js";

const answers: CreationDraftInput["answers"] = {
  goal: { kind: "fitness", weeks: 4 },
  availability: { mode: "flexible", weeklyHoursLimit: 6, longestWorkoutHours: 2 },
  startTiming: { kind: "as-soon-as-possible" },
  restriction: { kind: "none" },
  commitments: { kind: "none" },
  baseline: "regular",
  success: { kind: "fitness-choice", choice: "train-consistently" },
};

function choice(
  rules: CommitmentRule[],
  date: number,
  status: "confirmed" | "clarify" = "confirmed",
) {
  const confirmed: CreationDraftInput["answers"] = {
    ...answers,
    commitments: { kind: "interpreted", text: "Training limits", status, rules },
  };
  const draft = buildCreationDraft({ answers: confirmed, today: "1998-08-24", ftp: null });
  if (draft.kind !== "draft") throw new Error(draft.explanation);
  return readTodayChoice({ draft, answers: confirmed, todayDateKey: date });
}

describe("confirmed commitments in daily choice", () => {
  it.each([
    { kind: "weekday-unavailable", day: 3 },
    { kind: "time-off", start: "1998-08-25", end: "1998-08-27" },
  ] satisfies CommitmentRule[])("blocks all choices on an unavailable $kind day", (rule) => {
    expect(choice([rule], 19980826)).toMatchObject({
      eligible: [],
      reason: "Today is unavailable under your confirmed limits.",
    });
    expect(choice([rule], 19980828)?.eligible.length).toBeGreaterThan(0);
    expect(choice([rule], 19980826, "clarify")?.eligible.length).toBeGreaterThan(0);
  });

  it("respects both inclusive time-off boundaries within a partly available week", () => {
    const rules: CommitmentRule[] = [{ kind: "time-off", start: "1998-08-25", end: "1998-08-27" }];
    for (const date of [19980825, 19980826, 19980827]) {
      expect(choice(rules, date)?.eligible).toEqual([]);
    }
    for (const date of [19980824, 19980828]) {
      expect(choice(rules, date)?.eligible.length).toBeGreaterThan(0);
    }
  });

  it("filters hard Workouts and duration using confirmed weekday limits", () => {
    expect(
      choice([{ kind: "hard-weekday", day: 3 }], 19980826)?.eligible.every(
        (workout) => workout.kind !== "hard",
      ),
    ).toBe(true);
    const limited = choice([{ kind: "weekday-duration", day: 3, minutes: 45 }], 19980826);
    expect(limited?.eligible.length).toBeGreaterThan(0);
    expect(limited?.eligible.every((workout) => workout.minutes <= 45)).toBe(true);
    const draft = buildCreationDraft({ answers, today: "1998-08-24", ftp: null });
    if (draft.kind !== "draft") throw new Error(draft.explanation);
    const result = readTodayChoice({
      draft,
      todayDateKey: 19980826,
      answers: {
        ...answers,
        commitments: {
          kind: "interpreted",
          text: "Wed 45 minutes; no hard on Wed",
          status: "confirmed",
          rules: [
            { kind: "weekday-duration", day: 3, minutes: 45 },
            { kind: "hard-weekday", day: 3 },
          ],
        },
      },
    });
    expect(
      result?.blocked.some((workout) => workout.reason === "Today is limited to 45 minutes."),
    ).toBe(true);
    expect(result?.blocked.some((workout) => workout.reason === "No hard training today.")).toBe(
      true,
    );
  });
});
