import { describe, expect, it } from "vitest";
import {
  cleanupDeletes,
  planEndingStep,
  planEndingSummary,
  planIsClosedLocally,
  replacementMaySend,
  PLAN_ENDING_START,
  type AthleteChangesChoice,
  type PlanCopyOnIcu,
  type PlanEnding,
} from "../../src/planning/plan-ending.js";
import type { IcuCopy } from "../../src/planning/icu-copy.js";
import { walk, type Step } from "./state-walk.js";

const TODAY = 19980822;
const LATER = 19980825;

function onIcu(owner: "plan" | "athlete-edit", dateKey: number): IcuCopy {
  return {
    kind: "on-icu",
    baseline: {
      eventId: dateKey,
      dateKey,
      planFingerprint: `plan:${dateKey}`,
      readBack: { fingerprint: `icu:${dateKey}`, updated: "v1" },
      owner,
    },
  };
}

type Where = "there" | "removed";

interface World {
  readonly ending: PlanEnding;
  readonly today: Where;
  readonly later: Where;
  readonly edited: Where | "none";
  readonly replacementSent: "sent" | "not-sent";
}

function copies(world: World): readonly PlanCopyOnIcu[] {
  const entries: PlanCopyOnIcu[] = [];
  if (world.today === "there")
    entries.push({ planWorkoutId: "today", dateKey: TODAY, copy: onIcu("plan", TODAY) });
  if (world.later === "there")
    entries.push({ planWorkoutId: "later", dateKey: LATER, copy: onIcu("plan", LATER) });
  if (world.edited === "there") {
    entries.push({
      planWorkoutId: "edited",
      dateKey: LATER + 1,
      copy: onIcu("athlete-edit", LATER + 1),
    });
  }
  return entries;
}

function apply(world: World, ending: PlanEnding): World {
  return { ...world, ending };
}

function cleanupWorks(world: World): World {
  if (world.ending.kind !== "closed") return world;
  const removed = new Set(
    cleanupDeletes(copies(world), TODAY, world.ending.athleteChanges).map(
      (entry) => entry.planWorkoutId,
    ),
  );
  return {
    ...world,
    today: removed.has("today") ? "removed" : world.today,
    later: removed.has("later") ? "removed" : world.later,
    edited: removed.has("edited") ? "removed" : world.edited,
    ending: planEndingStep(world.ending, { type: "cleanup-verified" }),
  };
}

function choices(world: World): readonly AthleteChangesChoice[] {
  return world.edited === "there" ? ["keep-them", "remove-them"] : ["keep-them"];
}

function next(world: World): readonly Step<World>[] {
  const { ending } = world;
  const steps: Step<World>[] = [];
  if (ending.kind === "running") {
    steps.push([
      "the athlete presses End Plan",
      apply(world, planEndingStep(ending, { type: "athlete-presses-end" })),
    ]);
    steps.push([
      "the athlete starts replacing",
      apply(
        world,
        planEndingStep(ending, { type: "athlete-starts-replacing", replacementPlanId: "next" }),
      ),
    ]);
    steps.push([
      "race day passes",
      apply(world, planEndingStep(ending, { type: "race-day-passed", todayDateKey: TODAY })),
    ]);
    if (world.edited === "none")
      steps.push(["the athlete edits a later workout and keeps it", { ...world, edited: "there" }]);
  }
  if (ending.kind === "end-confirm-open") {
    steps.push([
      "the athlete cancels",
      apply(world, planEndingStep(ending, { type: "athlete-cancels" })),
    ]);
    for (const athleteChanges of choices(world)) {
      steps.push([
        `the athlete confirms End, ${athleteChanges}`,
        apply(
          world,
          planEndingStep(ending, {
            type: "athlete-confirms-end",
            todayDateKey: TODAY,
            athleteChanges,
          }),
        ),
      ]);
    }
  }
  if (ending.kind === "replacement-in-review") {
    for (const athleteChanges of choices(world)) {
      steps.push([
        `the athlete approves the replacement, ${athleteChanges}`,
        apply(
          world,
          planEndingStep(ending, {
            type: "athlete-approves-replacement",
            todayDateKey: TODAY,
            athleteChanges,
          }),
        ),
      ]);
    }
  }
  if (ending.kind === "closed") {
    if (ending.cleanup.kind === "running" || ending.cleanup.kind === "failed") {
      steps.push(["the cleanup works", cleanupWorks(world)]);
    }
    if (ending.cleanup.kind === "running") {
      steps.push([
        "the cleanup fails",
        apply(world, planEndingStep(ending, { type: "cleanup-failed" })),
      ]);
    }
    if (replacementMaySend(ending) && world.replacementSent === "not-sent") {
      steps.push(["the new Plan's weeks go out", { ...world, replacementSent: "sent" }]);
    }
  }
  return steps;
}

const RULES = {
  TodayIsKept: (world: World) => world.today === "there",
  NeverTwoPlansOnIntervals: (world: World) =>
    !(world.replacementSent === "sent" && world.later === "there"),
  LocalFirst: (world: World) =>
    !(world.ending.kind === "closed" && world.ending.cleanup.kind === "failed") ||
    planIsClosedLocally(world.ending),
  YourChangesAreNotDeletedByItself: (world: World) =>
    world.edited !== "removed" ||
    (world.ending.kind === "closed" && world.ending.athleteChanges === "remove-them"),
};

const START: World = {
  ending: PLAN_ENDING_START,
  today: "there",
  later: "there",
  edited: "none",
  replacementSent: "not-sent",
};

describe("End Plan and Replace Plan", () => {
  it("keeps every rule on every path", () => {
    const result = walk({
      initial: [START],
      next,
      key: (world) => JSON.stringify(world),
      rules: RULES,
      maxDepth: 10,
    });
    expect(result.broken).toEqual([]);
    expect(result.states).toBeGreaterThan(20);
  });

  it("keeps today's workout when the Plan ends", () => {
    const summary = planEndingSummary(copies(START), TODAY);
    expect(summary.staysToday.map((entry) => entry.planWorkoutId)).toEqual(["today"]);
    expect(summary.removes.map((entry) => entry.planWorkoutId)).toEqual(["later"]);
  });

  it("sends the new Plan's weeks only after the old ones are removed and checked", () => {
    const reviewing = planEndingStep(PLAN_ENDING_START, {
      type: "athlete-starts-replacing",
      replacementPlanId: "next",
    });
    const approved = planEndingStep(reviewing, {
      type: "athlete-approves-replacement",
      todayDateKey: TODAY,
      athleteChanges: "keep-them",
    });
    expect(planIsClosedLocally(approved)).toBe(true);
    expect(replacementMaySend(approved)).toBe(false);
    const failed = planEndingStep(approved, { type: "cleanup-failed" });
    expect(replacementMaySend(failed)).toBe(false);
    expect(replacementMaySend(planEndingStep(failed, { type: "cleanup-verified" }))).toBe(true);
  });

  it("lists the workouts the athlete changed apart and keeps them unless ticked", () => {
    const edited: World = { ...START, edited: "there" };
    const summary = planEndingSummary(copies(edited), TODAY);
    expect(summary.athleteChanges.map((entry) => entry.planWorkoutId)).toEqual(["edited"]);
    expect(
      cleanupDeletes(copies(edited), TODAY, "keep-them").map((entry) => entry.planWorkoutId),
    ).toEqual(["later"]);
    expect(
      cleanupDeletes(copies(edited), TODAY, "remove-them").map((entry) => entry.planWorkoutId),
    ).toEqual(["later", "edited"]);
  });

  it("closes the Plan locally before any cleanup runs", () => {
    const confirmOpen = planEndingStep(PLAN_ENDING_START, { type: "athlete-presses-end" });
    const ended = planEndingStep(confirmOpen, {
      type: "athlete-confirms-end",
      todayDateKey: TODAY,
      athleteChanges: "keep-them",
    });
    expect(ended).toMatchObject({ kind: "closed", reason: "ended", cleanup: { kind: "running" } });
    expect(planEndingStep(ended, { type: "cleanup-failed" })).toMatchObject({
      kind: "closed",
      cleanup: { kind: "failed" },
    });
  });
});
