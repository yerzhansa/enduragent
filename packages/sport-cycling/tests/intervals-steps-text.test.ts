import { describe, expect, it } from "vitest";
import {
  intervalsStepsText,
  workoutContent,
  type ContentWorkoutKind,
  type WorkoutContent,
} from "../src/workout-steps.js";

const STEP_LINE = /^- (?:(\d+)m(\d+)?|(\d+)s) (?:ramp )?\d+(?:-\d+)?%$/u;
const REPEAT_LINE = /^(\d+)x$/u;
const HEADERS = { Warmup: "warm-up", Cooldown: "cool-down" } as const;

function describedSeconds(text: string): number {
  let total = 0;
  let times = 1;
  for (const line of text.split("\n")) {
    const repeat = REPEAT_LINE.exec(line);
    if (repeat !== null) times = Number(repeat[1]);
    if (line === "") times = 1;
    const step = STEP_LINE.exec(line);
    if (step === null) continue;
    const seconds =
      step[3] === undefined ? Number(step[1]) * 60 + Number(step[2] ?? 0) : Number(step[3]);
    total += times * seconds;
  }
  return total;
}

function content(kind: ContentWorkoutKind, minutes: number): WorkoutContent {
  const built = workoutContent(kind, minutes);
  if (built === undefined) throw new TypeError("No content");
  return built;
}

function topLevelParts(built: WorkoutContent): readonly string[] {
  return built.blocks.flatMap((block) => (block.kind === "step" ? [block.step.part] : []));
}

describe("the intervals.icu steps text for workout content", () => {
  it.each(["hard", "endurance", "long", "easy"] as const)(
    "writes only headers, step and repeat lines for every %s workout from 10 to 180 minutes, adding up to its length",
    (kind) => {
      for (let minutes = 10; minutes <= 180; minutes += 1) {
        const built = content(kind, minutes);
        const text = intervalsStepsText(built);
        const lines = text.split("\n");
        for (const line of lines) {
          expect(
            line === "" || line in HEADERS || STEP_LINE.test(line) || REPEAT_LINE.test(line),
            line,
          ).toBe(true);
        }
        expect(describedSeconds(text), `${kind} ${minutes}`).toBe(minutes * 60);
        expect(text, `${kind} ${minutes}`).not.toMatch(/^\n|\n\n\n|\n$/u);
        const parts = topLevelParts(built);
        for (const [header, part] of Object.entries(HEADERS)) {
          expect(
            lines.filter((line) => line === header),
            `${kind} ${minutes} ${header}`,
          ).toHaveLength(parts.filter((entry) => entry === part).length);
        }
        lines.forEach((line, index) => {
          if (!(line in HEADERS)) return;
          expect(index === 0 || lines[index - 1] === "", `${kind} ${minutes} ${index}`).toBe(true);
          expect(lines[index + 1] ?? "", `${kind} ${minutes} ${index}`).toMatch(STEP_LINE);
        });
      }
    },
  );

  it("heads only a warm-up or cool-down step the builder made", () => {
    expect(intervalsStepsText(content("easy", 10))).toBe("- 10m 45-54%");
    expect(intervalsStepsText(content("easy", 30))).toBe(
      ["Warmup", "- 5m 45-54%", "- 25m 45-54%"].join("\n"),
    );
  });

  it("keeps a steady block next to the warm-up, with a blank line before the cool-down", () => {
    expect(intervalsStepsText(content("long", 100))).toBe(
      ["Warmup", "- 10m 45-65%", "- 80m 56-75%", "", "Cooldown", "- 10m 45%"].join("\n"),
    );
  });

  it("closes a repeat with a blank line so the cool-down is not repeated", () => {
    expect(intervalsStepsText(content("hard", 45))).toBe(
      [
        "Warmup",
        "- 10m 45-65%",
        "",
        "3x",
        "- 6m 88-94%",
        "- 3m 50%",
        "",
        "Cooldown",
        "- 8m 45%",
      ].join("\n"),
    );
  });

  it("writes seconds, a ramp down and back-to-back repeats as intervals.icu reads them", () => {
    const steady = (seconds: number, percent: number) => ({
      part: "interval" as const,
      seconds,
      target: { kind: "steady" as const, percent },
    });
    expect(
      intervalsStepsText({
        version: 1,
        zone: "endurance",
        load: 10,
        why: "aerobic-base",
        blocks: [
          {
            kind: "step",
            step: { part: "warm-up", seconds: 340, target: { kind: "ramp", from: 45, to: 65 } },
          },
          { kind: "repeat", times: 3, steps: [steady(30, 120), steady(120, 50)] },
          { kind: "repeat", times: 2, steps: [steady(60, 105), steady(60, 50)] },
          {
            kind: "step",
            step: { part: "cool-down", seconds: 300, target: { kind: "ramp", from: 65, to: 40 } },
          },
        ],
      }),
    ).toBe(
      [
        "Warmup",
        "- 5m40 ramp 45-65%",
        "",
        "3x",
        "- 30s 120%",
        "- 2m 50%",
        "",
        "2x",
        "- 1m 105%",
        "- 1m 50%",
        "",
        "Cooldown",
        "- 5m ramp 65-40%",
      ].join("\n"),
    );
  });
});
