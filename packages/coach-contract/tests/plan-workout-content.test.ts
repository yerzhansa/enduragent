import { describe, expect, it } from "vitest";
import {
  PlanCreationDraftSchema,
  PlanCreationDraftWorkoutSchema,
  PlanWorkoutContentSchema,
  planWorkoutContentSeconds,
  type PlanWorkoutContent,
} from "../src/index.js";

const sweetSpot: PlanWorkoutContent = {
  version: 1,
  zone: "sweet-spot",
  load: 36,
  why: "sustained-power",
  blocks: [
    {
      kind: "step",
      step: { part: "warm-up", seconds: 600, target: { kind: "range", low: 45, high: 65 } },
    },
    {
      kind: "repeat",
      times: 3,
      steps: [
        { part: "interval", seconds: 360, target: { kind: "range", low: 88, high: 94 } },
        { part: "recovery", seconds: 180, target: { kind: "steady", percent: 50 } },
      ],
    },
    {
      kind: "step",
      step: { part: "cool-down", seconds: 480, target: { kind: "steady", percent: 45 } },
    },
  ],
};

const workout = {
  id: "w1-template-1",
  name: "Controlled effort",
  kind: "hard",
  date: "1998-09-02",
  minutes: 45,
  pinned: false,
  power: null,
  guidance: "Use comfortable perceived effort or your known heart-rate guidance",
};

function draft(builderVersion: string, workouts: readonly object[]) {
  return {
    kind: "draft",
    answeredSummaries: [],
    goal: { kind: "fitness", weeks: 4 },
    mode: "fixed",
    start: "1998-09-02",
    end: "1998-09-29",
    spanKind: "Fitness Plan",
    computedWeeks: 4,
    weeks: [{ number: 1, start: "1998-09-02", end: "1998-09-08", notes: [], workouts }],
    notes: [],
    guidance: "Use comfortable perceived effort or your known heart-rate guidance",
    ftp: null,
    supportingEvents: [],
    builderId: "cycling-creation-draft",
    builderVersion,
    inputFingerprint: "a".repeat(64),
    outputFingerprint: "b".repeat(64),
  };
}

describe("Plan Workout content", () => {
  it.each(["1", "2"])("parses a stored v%s Draft without content unchanged", (version) => {
    const stored = draft(version, [workout]);
    const parsed = PlanCreationDraftSchema.parse(structuredClone(stored));
    expect(parsed).toEqual(stored);
    expect(parsed.weeks[0]?.workouts[0]).not.toHaveProperty("content");
  });

  it("keeps a v3 workout's steps exactly as stored", () => {
    const stored = draft("3", [{ ...workout, content: sweetSpot }]);
    expect(PlanCreationDraftSchema.parse(structuredClone(stored))).toEqual(stored);
    expect(planWorkoutContentSeconds(sweetSpot)).toBe(45 * 60);
  });

  it("refuses steps that do not add up to the workout's minutes", () => {
    const result = PlanCreationDraftWorkoutSchema.safeParse({
      ...workout,
      minutes: 50,
      content: sweetSpot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["content"]);
  });

  it("refuses content on an event workout", () => {
    expect(
      PlanCreationDraftWorkoutSchema.safeParse({ ...workout, kind: "event", content: sweetSpot })
        .success,
    ).toBe(false);
  });

  it.each([
    ["watts", { ...sweetSpot, watts: 200 }],
    [
      "an inverted range",
      {
        ...sweetSpot,
        blocks: [
          {
            kind: "step",
            step: { part: "main", seconds: 2_700, target: { kind: "range", low: 75, high: 56 } },
          },
        ],
      },
    ],
    [
      "a step under ten seconds",
      {
        ...sweetSpot,
        blocks: [
          {
            kind: "step",
            step: { part: "main", seconds: 5, target: { kind: "steady", percent: 60 } },
          },
        ],
      },
    ],
    [
      "one repeat",
      {
        ...sweetSpot,
        blocks: [
          {
            kind: "repeat",
            times: 1,
            steps: sweetSpot.blocks[1]?.kind === "repeat" ? sweetSpot.blocks[1].steps : [],
          },
        ],
      },
    ],
    ["fractional load", { ...sweetSpot, load: 36.5 }],
    ["an unknown zone", { ...sweetSpot, zone: "threshold" }],
  ])("refuses content with %s", (_label, content) => {
    expect(PlanWorkoutContentSchema.safeParse(content).success).toBe(false);
  });
});
