import { describe, expect, it } from "vitest";
import {
  coachTextMarker,
  coachTextStep,
  COACH_TEXT_NOT_WRITTEN,
  type CoachText,
  type CoachTextBasis,
  type CoachTextEvent,
} from "../../src/planning/coach-text.js";
import { walk, type Step } from "./state-walk.js";

type Match = "pending" | "workout:thu" | "no-workout";

interface World {
  readonly match: Match;
  readonly page: "open" | "closed";
  readonly text: CoachText;
  readonly replies: number;
  readonly asks: number;
  readonly model: "up" | "down";
}

function basis(match: Match): CoachTextBasis {
  return match === "pending" ? { kind: "waiting-for-match" } : { kind: "decided", key: match };
}

function apply(world: World, event: CoachTextEvent, asked: "asked" | "not-asked"): World {
  const step = coachTextStep(world.text, event);
  return {
    ...world,
    text: step.text,
    replies: world.replies + (step.effect.kind === "write" ? 1 : 0),
    asks: world.asks + (asked === "asked" ? 1 : 0),
  };
}

function next(world: World): readonly Step<World>[] {
  const steps: Step<World>[] = [];
  if (world.page === "closed") {
    steps.push([
      "the athlete opens it",
      {
        ...apply(world, { type: "athlete-opens", basis: basis(world.match) }, "asked"),
        page: "open",
      },
    ]);
  } else {
    steps.push(["the athlete leaves", { ...world, page: "closed" }]);
    if (world.match !== "pending" && (world.text.kind === "kept" || world.text.kind === "failed")) {
      steps.push([
        "the athlete presses Write again",
        apply(world, { type: "athlete-asks-again", basis: basis(world.match) }, "asked"),
      ]);
    }
  }
  if (world.match === "pending") {
    for (const decided of ["workout:thu", "no-workout"] as const) {
      steps.push([
        `the athlete decides the match: ${decided}`,
        {
          ...apply(
            { ...world, match: decided },
            { type: "match-decided", basis: basis(decided), page: world.page },
            "not-asked",
          ),
        },
      ]);
    }
  } else {
    const other = world.match === "workout:thu" ? "no-workout" : "workout:thu";
    steps.push([`the athlete changes the match later to ${other}`, { ...world, match: other }]);
  }
  if (world.text.kind === "writing") {
    steps.push(
      world.model === "up"
        ? ["the coach finishes", apply(world, { type: "writing-finished" }, "not-asked")]
        : ["the coach fails", apply(world, { type: "writing-failed" }, "not-asked")],
    );
  }
  steps.push([
    "the model goes up or down",
    { ...world, model: world.model === "up" ? "down" : "up" },
  ]);
  return steps;
}

const RULES = {
  NoReplyWithoutAsking: (world: World) => world.replies <= world.asks,
  NoTextBeforeTheMatch: (world: World) =>
    world.text.kind !== "writing" || world.text.startedFor !== "pending",
  KeptTextIsHonest: (world: World) =>
    world.text.kind !== "kept" ||
    world.text.writtenFor === world.match ||
    coachTextMarker(world.text, basis(world.match)).kind === "written-for-another-match",
};

const STARTS: readonly World[] = (["pending", "no-workout"] as const).flatMap((match) =>
  (["up", "down"] as const).map((model) => ({
    match,
    page: "closed" as const,
    text: COACH_TEXT_NOT_WRITTEN,
    replies: 0,
    asks: 0,
    model,
  })),
);

describe("the coach's text for an Activity or a missed workout", () => {
  it("keeps every rule on every path with at most two asks", () => {
    const result = walk({
      initial: STARTS,
      next,
      key: (world) => JSON.stringify(world),
      rules: RULES,
      maxDepth: 12,
      within: (world) => world.asks <= 2 && world.replies <= 2,
    });
    expect(result.broken).toEqual([]);
    expect(result.states).toBeGreaterThan(50);
  });

  it("says which match a kept review was written for after the match changes", () => {
    const opened = coachTextStep(COACH_TEXT_NOT_WRITTEN, {
      type: "athlete-opens",
      basis: { kind: "decided", key: "no-workout" },
    });
    expect(opened.effect).toEqual({ kind: "write", for: "no-workout" });
    const kept = coachTextStep(opened.text, { type: "writing-finished" }).text;
    expect(coachTextMarker(kept, { kind: "decided", key: "no-workout" })).toEqual({
      kind: "current",
    });
    expect(coachTextMarker(kept, { kind: "decided", key: "workout:thu" })).toEqual({
      kind: "written-for-another-match",
      writtenFor: "no-workout",
    });
  });

  it("waits for Confirm or Not this one before writing", () => {
    const opened = coachTextStep(COACH_TEXT_NOT_WRITTEN, {
      type: "athlete-opens",
      basis: { kind: "waiting-for-match" },
    });
    expect(opened.effect).toEqual({ kind: "none" });
    const decided = coachTextStep(opened.text, {
      type: "match-decided",
      basis: { kind: "decided", key: "workout:thu" },
      page: "open",
    });
    expect(decided.effect).toEqual({ kind: "write", for: "workout:thu" });
  });

  it("never rewrites a kept text by itself", () => {
    const kept: CoachText = { kind: "kept", writtenFor: "no-workout" };
    expect(
      coachTextStep(kept, { type: "athlete-opens", basis: { kind: "decided", key: "workout:thu" } })
        .effect,
    ).toEqual({
      kind: "none",
    });
    expect(
      coachTextStep(kept, {
        type: "match-decided",
        basis: { kind: "decided", key: "workout:thu" },
        page: "open",
      }).effect,
    ).toEqual({ kind: "none" });
  });

  it("tries a failed text again only when the athlete opens it or asks", () => {
    const failed: CoachText = { kind: "failed", startedFor: "no-workout" };
    expect(
      coachTextStep(failed, {
        type: "match-decided",
        basis: { kind: "decided", key: "no-workout" },
        page: "open",
      }).effect,
    ).toEqual({ kind: "none" });
    expect(
      coachTextStep(failed, {
        type: "athlete-opens",
        basis: { kind: "decided", key: "no-workout" },
      }).effect,
    ).toEqual({
      kind: "write",
      for: "no-workout",
    });
  });
});
