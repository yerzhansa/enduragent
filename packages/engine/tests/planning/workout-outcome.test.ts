import { describe, expect, it } from "vitest";
import type {
  PlanActivityObservation,
  PlanWorkoutMatchRecord,
  PlanWorkoutMatchRepository,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { refreshPlanWorkoutMatches } from "../../src/planning/workout-match.js";
import {
  outcomeCount,
  outcomeCountsTowardPlanned,
  workoutOutcome,
  type OutcomeMatch,
  type SyncCoverage,
  type WorkoutOutcome,
} from "../../src/planning/workout-outcome.js";
import { icuCopyKeep, icuCopyOnRun, type IcuCopy } from "../../src/planning/icu-copy.js";
import { walk, type Step } from "./state-walk.js";

const DAY = 19980821;
const NEXT_DAY = 19980822;
const OLD_DAY = 19980820;

type Ride = { readonly kind: "none" } | { readonly kind: "rode"; readonly onDateKey: number };

interface World {
  readonly today: number;
  readonly ride: Ride;
  readonly seen: "synced" | "not-synced";
  readonly lastFinishedSync: SyncCoverage;
  readonly match: OutcomeMatch;
  readonly place: "in-plan" | "removed-by-you";
}

function outcome(world: World): WorkoutOutcome {
  return workoutOutcome({
    workout: { dateKey: DAY, durationS: 3_600, place: world.place },
    match: world.match,
    todayDateKey: world.today,
    lastFinishedSync: world.lastFinishedSync,
  });
}

function syncRuns(world: World): World {
  const seen = world.ride.kind === "rode" ? "synced" : world.seen;
  const suggest =
    world.ride.kind === "rode" && world.match.kind === "none" && world.ride.onDateKey === DAY;
  return {
    ...world,
    seen,
    lastFinishedSync: { kind: "started-on", dateKey: world.today },
    match: suggest ? { kind: "suggested", matchId: "m1", activityId: "a1" } : world.match,
  };
}

function rideDateKey(world: World): number {
  return world.ride.kind === "rode" ? world.ride.onDateKey : DAY;
}

function next(world: World): readonly Step<World>[] {
  const steps: Step<World>[] = [["a sync runs", syncRuns(world)]];
  if (world.today === DAY) steps.push(["the day ends", { ...world, today: NEXT_DAY }]);
  if (world.ride.kind === "none") {
    for (const onDateKey of world.today === DAY ? [DAY, OLD_DAY] : [OLD_DAY]) {
      steps.push([
        `the athlete rides on ${onDateKey}`,
        { ...world, ride: { kind: "rode", onDateKey } },
      ]);
    }
  }
  if (world.match.kind === "suggested") {
    const confirmed: OutcomeMatch = {
      kind: "confirmed",
      matchId: "m1",
      activityId: "a1",
      activityDateKey: rideDateKey(world),
      activityDurationS: 3_500,
    };
    steps.push(["the athlete confirms", { ...world, match: confirmed }]);
    steps.push(["the athlete says Not this one", { ...world, match: { kind: "rejected" } }]);
  }
  if (world.seen === "synced" && (world.match.kind === "none" || world.match.kind === "rejected")) {
    steps.push([
      "the athlete picks this ride from the calendar",
      {
        ...world,
        match: {
          kind: "confirmed",
          matchId: "m2",
          activityId: "a1",
          activityDateKey: rideDateKey(world),
          activityDurationS: 3_500,
        },
      },
    ]);
  }
  if (world.place === "in-plan" && world.match.kind !== "confirmed") {
    steps.push([
      "the athlete keeps a deletion made in intervals.icu",
      { ...world, place: "removed-by-you" },
    ]);
  }
  return steps;
}

const RULES = {
  MissedIsTrue: (world: World) =>
    outcome(world).kind !== "missed" ||
    (world.lastFinishedSync.kind === "started-on" &&
      world.lastFinishedSync.dateKey > DAY &&
      !(
        world.ride.kind === "rode" &&
        world.ride.onDateKey === DAY &&
        world.match.kind !== "rejected"
      )),
  RemovedIsNeverMissed: (world: World) =>
    world.place !== "removed-by-you" || outcome(world).kind !== "missed",
  OnlyConfirmedCounts: (world: World) =>
    outcomeCount(outcome(world)) !== "counts-done" || world.match.kind === "confirmed",
  RideOnTheDayIsSuggested: (world: World) =>
    !(
      world.seen === "synced" &&
      world.ride.kind === "rode" &&
      world.ride.onDateKey === DAY &&
      world.match.kind === "none"
    ),
};

const START: World = {
  today: DAY,
  ride: { kind: "none" },
  seen: "not-synced",
  lastFinishedSync: { kind: "never" },
  match: { kind: "none" },
  place: "in-plan",
};

function memoryMatches(activities: readonly PlanActivityObservation[]) {
  const records: PlanWorkoutMatchRecord[] = [];
  const repository: PlanWorkoutMatchRepository = {
    listActivities: async () => activities,
    readProviderIdentities: async () => [],
    readForPlan: async () => records,
    readForWorkout: async () => records,
    readSyncStatus: async () => {
      throw new Error("not used");
    },
    observe: async (input) => {
      records.push(input);
      return input;
    },
    decide: async () => {
      throw new Error("not used");
    },
    withdraw: async () => {
      throw new Error("not used");
    },
    clearUnpaired: async () => {
      throw new Error("not used");
    },
  };
  return { repository, records };
}

describe("a Plan Workout's result on the calendar", () => {
  it("keeps every rule on every path of up to eight steps", () => {
    const result = walk({
      initial: [START],
      next,
      key: (world) => JSON.stringify(world),
      rules: RULES,
      maxDepth: 8,
    });
    expect(result.broken).toEqual([]);
    expect(result.states).toBeGreaterThan(30);
  });

  it("says Not synced yet, not Missed, the morning after when no sync has run", () => {
    const morning: World = { ...START, today: NEXT_DAY };
    expect(outcome(morning)).toEqual({ kind: "not-synced-yet" });
    const syncedBeforeMidnight = syncRuns(START);
    expect(outcome({ ...syncedBeforeMidnight, today: NEXT_DAY })).toEqual({
      kind: "not-synced-yet",
    });
    expect(outcome(syncRuns(morning))).toEqual({ kind: "missed" });
  });

  it("corrects a Missed by itself when a late sync brings the ride", () => {
    const rode: World = { ...START, ride: { kind: "rode", onDateKey: DAY } };
    const morning = { ...rode, today: NEXT_DAY };
    expect(outcome(morning).kind).toBe("not-synced-yet");
    expect(outcome(syncRuns(morning))).toMatchObject({ kind: "is-this-it" });
  });

  it("never counts Removed by you as Missed or as planned time", () => {
    const removed = syncRuns({ ...START, today: NEXT_DAY, place: "removed-by-you" });
    expect(outcome(removed)).toEqual({ kind: "removed-by-you" });
    expect(outcomeCount(outcome(removed))).toBe("not-counted");
    expect(outcomeCountsTowardPlanned(outcome(removed))).toBe(false);
  });

  it("does not count an unconfirmed ride", () => {
    const suggested = syncRuns({ ...START, ride: { kind: "rode", onDateKey: DAY } });
    expect(outcome(suggested).kind).toBe("is-this-it");
    expect(outcomeCount(outcome(suggested))).toBe("not-counted");
  });

  it("suggests a ride on the day a kept intervals.icu move set", async () => {
    const movedTo = 19980823;
    const copy: IcuCopy = {
      kind: "on-icu",
      baseline: {
        eventId: 77,
        dateKey: DAY,
        planFingerprint: "plan:thu",
        readBack: { fingerprint: "icu:thu", updated: "v1" },
        owner: "plan",
      },
    };
    const moved = {
      kind: "present",
      eventId: 77,
      dateKey: movedTo,
      version: { fingerprint: "icu:sat", updated: "v2" },
    } as const;
    const card = icuCopyOnRun(copy, { kind: "send", planFingerprint: "plan:thu" }, moved);
    const kept = icuCopyKeep(
      card.copy,
      moved,
      { kind: "send", planFingerprint: "plan:thu" },
      "plan:sat",
    );
    expect(kept).toMatchObject({
      kind: "done",
      effect: { kind: "adopt-into-plan", dateKey: movedTo },
    });
    if (kept.kind !== "done" || kept.effect.kind !== "adopt-into-plan") throw new Error("not kept");
    const planId = `${"0".repeat(25)}1`;
    const workout: PlanWorkoutRecord = {
      id: `${"0".repeat(25)}2`,
      planId,
      dateKey: kept.effect.dateKey,
      sport: "cycling",
      name: "Easy endurance",
      durationS: 3_000,
      structureJson: "{}",
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 1,
      hlcCounter: 0,
    };
    const { repository } = memoryMatches([
      {
        activityId: "b".repeat(64),
        providerActivityId: "synthetic-1",
        dateKey: movedTo,
        sport: "Ride",
        durationS: 3_100,
        pairedEventId: null,
      },
    ]);
    let next = 0;
    const result = await refreshPlanWorkoutMatches({
      planId,
      workouts: [workout],
      startDateKey: DAY,
      endDateKey: movedTo,
      repository,
      identity: {
        newId: () => `${"1".repeat(25)}${(next += 1)}`,
        deviceId: async () => "device-1",
        stamp: () => ({ physicalMs: 1, counter: 0 }),
      },
    });
    expect(result.matches).toMatchObject([{ decision: "suggested", activityDateKey: movedTo }]);
  });
});
