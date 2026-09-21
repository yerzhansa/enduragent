import { describe, expect, it } from "vitest";
import { workoutEffortPlot } from "../src/workout-change-sets/effort.js";

describe("workout effort plots", () => {
  it("expands an exact 900-second repeat followed by a plain step", () => {
    const plot = workoutEffortPlot({
      durationSeconds: 900,
      structure: {
        steps: [
          {
            type: "warmup",
            duration: { value: 5, unit: "minutes" },
            power: { kind: "percent_ftp", low: 45, high: 65 },
          },
          {
            type: "set",
            repeat: 2,
            interval: {
              type: "interval",
              duration: { value: 2, unit: "minutes" },
              power: { kind: "percent_ftp", value: 75 },
            },
            recovery: {
              type: "recovery",
              duration: { value: 1, unit: "minutes" },
              power: { kind: "percent_ftp", value: 50 },
            },
          },
          {
            type: "steady",
            duration: { value: 4, unit: "minutes" },
            power: { kind: "percent_ftp", value: 45 },
          },
        ],
      },
    });

    expect(plot).toEqual({
      unit: "percent_ftp",
      segments: [
        { kind: "range", durationSeconds: 300, low: 45, high: 65 },
        { kind: "steady", durationSeconds: 120, target: 75 },
        { kind: "steady", durationSeconds: 60, target: 50 },
        { kind: "steady", durationSeconds: 120, target: 75 },
        { kind: "steady", durationSeconds: 60, target: 50 },
        { kind: "steady", durationSeconds: 240, target: 45 },
      ],
    });
  });

  it("expands nested provider repeats in their exact order", () => {
    const plot = workoutEffortPlot({
      durationSeconds: 480,
      structure: {
        steps: [
          {
            reps: 2,
            steps: [
              {
                reps: 2,
                steps: [
                  { duration: 60, power: { units: "%ftp", value: 90 } },
                  { duration: 30, power: { units: "%ftp", value: 45 } },
                ],
              },
              { duration: 60, power: { units: "%ftp", value: 60 } },
            ],
          },
        ],
      },
    });

    expect(plot?.segments.map((segment) => segment.durationSeconds)).toEqual([
      60, 30, 60, 30, 60, 60, 30, 60, 30, 60,
    ]);
  });

  it("keeps a range distinct from an explicit ramp", () => {
    const plot = workoutEffortPlot({
      durationSeconds: 240,
      structure: {
        steps: [
          { duration: 120, power: { units: "%ftp", start: 50, end: 70 } },
          {
            duration: 120,
            ramp: true,
            power: { units: "%ftp", start: 50, end: 70 },
          },
        ],
      },
    });

    expect(plot?.segments).toEqual([
      { kind: "range", durationSeconds: 120, low: 50, high: 70 },
      { kind: "ramp", durationSeconds: 120, start: 50, end: 70 },
    ]);
  });

  it("falls back instead of combining mixed power units", () => {
    expect(
      workoutEffortPlot({
        durationSeconds: 120,
        structure: {
          steps: [
            { duration: 60, power: { units: "%ftp", value: 60 } },
            { duration: 60, power: { units: "watts", value: 160 } },
          ],
        },
      }),
    ).toBeNull();
  });

  it("falls back when expanded steps disagree with the saved duration", () => {
    expect(
      workoutEffortPlot({
        durationSeconds: 900,
        structure: { steps: [{ duration: 600, power: { units: "%ftp", value: 60 } }] },
      }),
    ).toBeNull();
  });

  it("falls back before deeply nested or explosively repeated input can consume unbounded work", () => {
    const nested: { steps: unknown[] } = { steps: [] };
    let current = nested;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: { steps: unknown[] } = { steps: [] };
      current.steps.push({ reps: 1, steps: next.steps });
      current = next;
    }
    current.steps.push({ duration: 1, power: { units: "%ftp", value: 50 } });
    expect(workoutEffortPlot({ durationSeconds: 1, structure: nested })).toBeNull();
    expect(
      workoutEffortPlot({
        durationSeconds: 20_000,
        structure: {
          steps: [
            {
              reps: 20_000,
              steps: [{ duration: 1, power: { units: "%ftp", value: 50 } }],
            },
          ],
        },
      }),
    ).toBeNull();
  });
});
