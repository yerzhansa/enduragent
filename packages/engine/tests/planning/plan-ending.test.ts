import { describe, expect, it } from "vitest";
import { addCivilDays } from "@enduragent/kernel/planning";
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
const TOMORROW = 19980823;
const LATER = 19980825;

function onIcu(
  owner: "plan" | "athlete-edit",
  dateKey: number,
  fingerprint = `icu:${dateKey}`,
): IcuCopy {
  return {
    kind: "on-icu",
    baseline: {
      eventId: dateKey,
      dateKey,
      planFingerprint: `plan:${dateKey}`,
      readBack: { fingerprint, updated: "v1" },
      owner,
    },
  };
}

function editedLater(baseline: IcuCopy, fingerprint: string): IcuCopy {
  if (baseline.kind !== "on-icu") return baseline;
  return {
    kind: "changed-in-icu",
    baseline: baseline.baseline,
    shown: {
      kind: "present",
      eventId: baseline.baseline.eventId,
      dateKey: baseline.baseline.dateKey,
      version: { fingerprint, updated: "v2" },
    },
  };
}

type Where = "there" | "removed";
type Edited = "none" | "kept" | "edited-again";

interface World {
  readonly ending: PlanEnding;
  readonly day: number;
  readonly today: Where;
  readonly tomorrow: Where;
  readonly later: Where;
  readonly edited: Edited;
  readonly editedWhere: Where;
  readonly confirmed: "before-confirm" | "listed-kept" | "listed-edited-again";
  readonly replacementSent: "sent" | "not-sent";
}

function editedCopy(world: World): IcuCopy {
  const kept = onIcu("athlete-edit", LATER + 1, "icu:athlete");
  return world.edited === "edited-again" ? editedLater(kept, "icu:athlete-2") : kept;
}

function copies(world: World): readonly PlanCopyOnIcu[] {
  const entries: PlanCopyOnIcu[] = [];
  if (world.today === "there")
    entries.push({ planWorkoutId: "today", dateKey: TODAY, copy: onIcu("plan", TODAY) });
  if (world.tomorrow === "there") {
    entries.push({ planWorkoutId: "tomorrow", dateKey: TOMORROW, copy: onIcu("plan", TOMORROW) });
  }
  if (world.later === "there")
    entries.push({ planWorkoutId: "later", dateKey: LATER, copy: onIcu("plan", LATER) });
  if (world.edited !== "none" && world.editedWhere === "there") {
    entries.push({ planWorkoutId: "edited", dateKey: LATER + 1, copy: editedCopy(world) });
  }
  return entries;
}

function cleanupWorks(world: World): World {
  const removed = new Set(
    cleanupDeletes(copies(world), world.ending).map((entry) => entry.planWorkoutId),
  );
  return {
    ...world,
    today: removed.has("today") ? "removed" : world.today,
    tomorrow: removed.has("tomorrow") ? "removed" : world.tomorrow,
    later: removed.has("later") ? "removed" : world.later,
    editedWhere: removed.has("edited") ? "removed" : world.editedWhere,
    ending: planEndingStep(world.ending, { type: "cleanup-verified" }),
  };
}

function choices(world: World): readonly AthleteChangesChoice[] {
  const listed = planEndingSummary(copies(world), world.day).athleteChanges;
  if (listed.length === 0) return [{ kind: "keep-them" }];
  return [
    { kind: "keep-them" },
    { kind: "remove-them", ticked: listed.map((entry) => entry.tick) },
  ];
}

function confirmedAs(world: World): World["confirmed"] {
  if (world.edited === "kept") return "listed-kept";
  if (world.edited === "edited-again") return "listed-edited-again";
  return "before-confirm";
}

function next(world: World): readonly Step<World>[] {
  const { ending } = world;
  const steps: Step<World>[] = [];
  if (world.day === TODAY) steps.push(["a day passes", { ...world, day: TOMORROW }]);
  if (world.edited === "none" && ending.kind !== "closed") {
    steps.push(["the athlete edits a later workout and keeps it", { ...world, edited: "kept" }]);
  }
  if (world.edited === "kept" && world.editedWhere === "there") {
    steps.push([
      "the athlete edits it again in intervals.icu",
      { ...world, edited: "edited-again" },
    ]);
  }
  if (ending.kind === "running") {
    steps.push([
      "the athlete presses End Plan",
      { ...world, ending: planEndingStep(ending, { type: "athlete-presses-end" }) },
    ]);
    steps.push([
      "the athlete starts replacing",
      {
        ...world,
        ending: planEndingStep(ending, {
          type: "athlete-starts-replacing",
          replacementPlanId: "next",
        }),
      },
    ]);
    steps.push([
      "race day passes",
      {
        ...world,
        ending: planEndingStep(ending, { type: "race-day-passed", todayDateKey: world.day }),
      },
    ]);
  }
  if (ending.kind === "end-confirm-open") {
    steps.push([
      "the athlete cancels",
      { ...world, ending: planEndingStep(ending, { type: "athlete-cancels" }) },
    ]);
    for (const athleteChanges of choices(world)) {
      steps.push([
        `the athlete confirms End, ${athleteChanges.kind}`,
        {
          ...world,
          confirmed: confirmedAs(world),
          ending: planEndingStep(ending, {
            type: "athlete-confirms-end",
            todayDateKey: world.day,
            athleteChanges,
          }),
        },
      ]);
    }
  }
  if (ending.kind === "replacement-in-review") {
    for (const athleteChanges of choices(world)) {
      steps.push([
        `the athlete approves the replacement, ${athleteChanges.kind}`,
        {
          ...world,
          confirmed: confirmedAs(world),
          ending: planEndingStep(ending, {
            type: "athlete-approves-replacement",
            todayDateKey: world.day,
            athleteChanges,
          }),
        },
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
        { ...world, ending: planEndingStep(ending, { type: "cleanup-failed" }) },
      ]);
    }
    if (replacementMaySend(ending) && world.replacementSent === "not-sent") {
      steps.push(["the new Plan's weeks go out", { ...world, replacementSent: "sent" }]);
    }
  }
  return steps;
}

function closedOn(world: World): number | null {
  return world.ending.kind === "closed" && world.ending.reason !== "completed"
    ? world.ending.closedOnDateKey
    : null;
}

const RULES = {
  TodayIsKept: (world: World) => closedOn(world) !== TODAY || world.today === "there",
  NeverTwoPlansOnIntervals: (world: World) =>
    !(
      world.replacementSent === "sent" &&
      (world.later === "there" || (closedOn(world) === TODAY && world.tomorrow === "there"))
    ),
  LocalFirst: (world: World) =>
    !(world.ending.kind === "closed" && world.ending.cleanup.kind === "failed") ||
    planIsClosedLocally(world.ending),
  YourChangesAreNotDeletedByItself: (world: World) =>
    world.editedWhere !== "removed" ||
    (world.ending.kind === "closed" &&
      world.ending.athleteChanges.kind === "remove-them" &&
      ((world.confirmed === "listed-kept" && world.edited === "kept") ||
        (world.confirmed === "listed-edited-again" && world.edited === "edited-again"))),
};

const START: World = {
  ending: PLAN_ENDING_START,
  day: TODAY,
  today: "there",
  tomorrow: "there",
  later: "there",
  edited: "none",
  editedWhere: "there",
  confirmed: "before-confirm",
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
    expect(result.states).toBeGreaterThan(100);
  });

  it("keeps today's workout when the Plan ends", () => {
    const summary = planEndingSummary(copies(START), TODAY);
    expect(summary.staysToday.map((entry) => entry.planWorkoutId)).toEqual(["today"]);
    expect(summary.removes.map((entry) => entry.planWorkoutId)).toEqual(["tomorrow", "later"]);
  });

  it("removes from the day after the Plan closed, even when the cleanup retries a day later", () => {
    const open = planEndingStep(PLAN_ENDING_START, { type: "athlete-presses-end" });
    const ended = planEndingStep(open, {
      type: "athlete-confirms-end",
      todayDateKey: TODAY,
      athleteChanges: { kind: "keep-them" },
    });
    const failed = planEndingStep(ended, { type: "cleanup-failed" });
    expect(cleanupDeletes(copies(START), failed).map((entry) => entry.planWorkoutId)).toEqual([
      "tomorrow",
      "later",
    ]);
    expect(addCivilDays(TODAY, 1)).toBe(TOMORROW);
  });

  it("sends the new Plan's weeks only after the old ones are removed and checked", () => {
    const reviewing = planEndingStep(PLAN_ENDING_START, {
      type: "athlete-starts-replacing",
      replacementPlanId: "next",
    });
    const approved = planEndingStep(reviewing, {
      type: "athlete-approves-replacement",
      todayDateKey: TODAY,
      athleteChanges: { kind: "keep-them" },
    });
    expect(planIsClosedLocally(approved)).toBe(true);
    expect(replacementMaySend(approved)).toBe(false);
    const failed = planEndingStep(approved, { type: "cleanup-failed" });
    expect(replacementMaySend(failed)).toBe(false);
    expect(replacementMaySend(planEndingStep(failed, { type: "cleanup-verified" }))).toBe(true);
  });

  it("lists the workouts the athlete changed apart and removes only the ticked version", () => {
    const edited: World = { ...START, edited: "kept" };
    const summary = planEndingSummary(copies(edited), TODAY);
    expect(summary.athleteChanges.map((entry) => entry.tick)).toEqual([
      { planWorkoutId: "edited", eventId: LATER + 1, fingerprint: "icu:athlete" },
    ]);
    const open = planEndingStep(PLAN_ENDING_START, { type: "athlete-presses-end" });
    const keepThem = planEndingStep(open, {
      type: "athlete-confirms-end",
      todayDateKey: TODAY,
      athleteChanges: { kind: "keep-them" },
    });
    expect(cleanupDeletes(copies(edited), keepThem).map((entry) => entry.planWorkoutId)).toEqual([
      "tomorrow",
      "later",
    ]);
    const removeThem = planEndingStep(open, {
      type: "athlete-confirms-end",
      todayDateKey: TODAY,
      athleteChanges: {
        kind: "remove-them",
        ticked: summary.athleteChanges.map((entry) => entry.tick),
      },
    });
    expect(cleanupDeletes(copies(edited), removeThem).map((entry) => entry.planWorkoutId)).toEqual([
      "tomorrow",
      "later",
      "edited",
    ]);
    const editedAfterConfirm: World = { ...edited, edited: "edited-again" };
    expect(
      cleanupDeletes(copies(editedAfterConfirm), removeThem).map((entry) => entry.planWorkoutId),
    ).toEqual(["tomorrow", "later"]);
  });

  it("closes the Plan locally before any cleanup runs", () => {
    const confirmOpen = planEndingStep(PLAN_ENDING_START, { type: "athlete-presses-end" });
    const ended = planEndingStep(confirmOpen, {
      type: "athlete-confirms-end",
      todayDateKey: TODAY,
      athleteChanges: { kind: "keep-them" },
    });
    expect(ended).toMatchObject({ kind: "closed", reason: "ended", cleanup: { kind: "running" } });
    expect(planEndingStep(ended, { type: "cleanup-failed" })).toMatchObject({
      kind: "closed",
      cleanup: { kind: "failed" },
    });
  });
});
