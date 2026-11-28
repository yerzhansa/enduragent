import { describe, expect, it } from "vitest";
import {
  workoutContent,
  type ContentWorkoutKind,
  type WorkoutContent,
  type WorkoutStep,
} from "../src/workout-steps.js";

type Row = readonly [part: string, minutes: number, target: string];

function targetText(entry: WorkoutStep) {
  const value = entry.target;
  return value.kind === "steady"
    ? `${value.percent}`
    : value.kind === "range"
      ? `${value.low}-${value.high}`
      : `${value.from}>${value.to}`;
}

function rows(content: WorkoutContent | undefined): Row[] {
  if (content === undefined) throw new TypeError("No content");
  return content.blocks.flatMap((block): Row[] =>
    block.kind === "step"
      ? [[block.step.part, block.step.seconds / 60, targetText(block.step)]]
      : block.steps.map((entry): Row => [
          `${block.times}x ${entry.part}`,
          entry.seconds / 60,
          targetText(entry),
        ]),
  );
}

function totalSeconds(content: WorkoutContent): number {
  return content.blocks.reduce(
    (sum, block) =>
      sum +
      (block.kind === "step"
        ? block.step.seconds
        : block.times * block.steps.reduce((inner, entry) => inner + entry.seconds, 0)),
    0,
  );
}

describe("workout content for Chat Plan workouts", () => {
  it("builds the sweet spot workout from the brief at 45 minutes", () => {
    const content = workoutContent("hard", 45);
    expect(content).toMatchObject({ version: 1, zone: "sweet-spot", why: "sustained-power" });
    expect(rows(content)).toEqual([
      ["warm-up", 10, "45-65"],
      ["3x interval", 6, "88-94"],
      ["3x recovery", 3, "50"],
      ["cool-down", 8, "45"],
    ]);
    expect(content?.load).toBe(36);
  });

  it.each([
    [
      40,
      [
        ["warm-up", 10, "45-65"],
        ["3x interval", 5, "88-94"],
        ["3x recovery", 3, "50"],
        ["cool-down", 6, "45"],
      ],
    ],
    [
      35,
      [
        ["warm-up", 8, "45-65"],
        ["3x interval", 4, "88-94"],
        ["3x recovery", 3, "50"],
        ["cool-down", 6, "45"],
      ],
    ],
    [
      34,
      [
        ["warm-up", 8, "45-65"],
        ["2x interval", 7, "88-94"],
        ["2x recovery", 3, "50"],
        ["cool-down", 6, "45"],
      ],
    ],
    [
      30,
      [
        ["warm-up", 7, "45-65"],
        ["2x interval", 6, "88-94"],
        ["2x recovery", 3, "50"],
        ["cool-down", 5, "45"],
      ],
    ],
    [
      25,
      [
        ["warm-up", 6, "45-65"],
        ["2x interval", 4, "88-94"],
        ["2x recovery", 3, "50"],
        ["cool-down", 5, "45"],
      ],
    ],
  ] as const)("shrinks the sweet spot sets at %i minutes", (minutes, expected) => {
    const content = workoutContent("hard", minutes);
    expect(content?.zone).toBe("sweet-spot");
    expect(rows(content)).toEqual(expected);
  });

  it("turns a hard workout under 25 minutes into steady endurance", () => {
    const content = workoutContent("hard", 24);
    expect(content).toMatchObject({ zone: "endurance", why: "aerobic-base" });
    expect(rows(content)).toEqual([
      ["warm-up", 6, "45-65"],
      ["main", 14, "56-75"],
      ["cool-down", 4, "45"],
    ]);
  });

  it.each([
    [
      "endurance",
      60,
      "aerobic-base",
      [
        ["warm-up", 10, "45-65"],
        ["main", 40, "56-75"],
        ["cool-down", 10, "45"],
      ],
    ],
    [
      "endurance",
      45,
      "aerobic-base",
      [
        ["warm-up", 10, "45-65"],
        ["main", 26, "56-75"],
        ["cool-down", 9, "45"],
      ],
    ],
    [
      "long",
      100,
      "endurance",
      [
        ["warm-up", 10, "45-65"],
        ["main", 80, "56-75"],
        ["cool-down", 10, "45"],
      ],
    ],
    [
      "long",
      30,
      "endurance",
      [
        ["warm-up", 7, "45-65"],
        ["main", 17, "56-75"],
        ["cool-down", 6, "45"],
      ],
    ],
  ] as const)(
    "builds %s at %i minutes with a steady main block",
    (kind, minutes, why, expected) => {
      const content = workoutContent(kind, minutes);
      expect(content).toMatchObject({ zone: "endurance", why });
      expect(rows(content)).toEqual(expected);
    },
  );

  it("builds an easy ride with a five-minute warm-up, and one steady block under 15 minutes", () => {
    expect(workoutContent("easy", 30)).toMatchObject({ zone: "recovery", why: "recover" });
    expect(rows(workoutContent("easy", 30))).toEqual([
      ["warm-up", 5, "45-54"],
      ["main", 25, "45-54"],
    ]);
    expect(rows(workoutContent("easy", 15))).toEqual([
      ["warm-up", 5, "45-54"],
      ["main", 10, "45-54"],
    ]);
    expect(rows(workoutContent("easy", 14))).toEqual([["main", 14, "45-54"]]);
  });

  it("gives events and fractional minutes no content", () => {
    expect(workoutContent("event", 60)).toBeUndefined();
    expect(workoutContent("endurance", 37.5)).toBeUndefined();
    expect(workoutContent("easy", 0)).toBeUndefined();
  });

  it.each(["hard", "endurance", "long", "easy"] satisfies ContentWorkoutKind[])(
    "fills every whole minute from 1 to 180 exactly for %s, in whole minutes and percent only",
    (kind) => {
      for (let minutes = 1; minutes <= 180; minutes++) {
        const content = workoutContent(kind, minutes);
        if (content === undefined) throw new TypeError(`No ${kind} content at ${minutes}`);
        expect(totalSeconds(content), `${kind} ${minutes}`).toBe(minutes * 60);
        for (const [, stepMinutes, target] of rows(content)) {
          expect(Number.isInteger(stepMinutes) && stepMinutes >= 1, `${kind} ${minutes}`).toBe(
            true,
          );
          for (const percent of target.split(/[->]/u).map(Number)) {
            expect(Number.isInteger(percent) && percent >= 1 && percent <= 200).toBe(true);
          }
        }
        expect(Number.isInteger(content.load) && content.load >= 0).toBe(true);
        expect(JSON.stringify(content)).not.toMatch(/"(watts?|power|cadence|rpm)"/u);
      }
    },
  );

  it("weighs each step by its intensity squared, using a range's midpoint", () => {
    expect(workoutContent("easy", 60)?.load).toBe(Math.round((49.5 / 100) ** 2 * 100));
    expect(workoutContent("long", 100)?.load).toBe(
      Math.round((600 * 0.55 ** 2 + 4800 * 0.655 ** 2 + 600 * 0.45 ** 2) / 36),
    );
  });
});
