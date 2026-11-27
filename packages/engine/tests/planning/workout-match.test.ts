import { describe, expect, it } from "vitest";
import type {
  PlanActivityObservation,
  PlanWorkoutMatchRecord,
  PlanWorkoutMatchRepository,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  projectWorkoutMatches,
  refreshPlanWorkoutMatches,
} from "../../src/planning/workout-match.js";

const PLAN_ID = `${"0".repeat(25)}1`;
const ENDURANCE_ID = `${"0".repeat(25)}2`;
const RACE_ID = `${"0".repeat(25)}3`;
const ACTIVITY_ID = "a".repeat(64);

function workout(
  overrides: Partial<PlanWorkoutRecord> & Pick<PlanWorkoutRecord, "id">,
): PlanWorkoutRecord {
  return {
    planId: PLAN_ID,
    dateKey: 20260825,
    sport: "cycling",
    name: "Endurance",
    durationS: 5_400,
    structureJson: "{}",
    origin: "coach",
    deviceId: "device-1",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
    ...overrides,
  };
}

function memoryRepository(input: {
  activities: readonly PlanActivityObservation[];
  providerEventId?: number;
}): PlanWorkoutMatchRepository & { records: PlanWorkoutMatchRecord[] } {
  const records: PlanWorkoutMatchRecord[] = [];
  return {
    records,
    async observe(record) {
      const existing = records.find(
        (candidate) =>
          candidate.planWorkoutId === record.planWorkoutId &&
          candidate.activityId === record.activityId,
      );
      if (existing !== undefined) return existing;
      records.push(record);
      return record;
    },
    async readForPlan() {
      return records;
    },
    async readForWorkout(planWorkoutId) {
      return records.filter((record) => record.planWorkoutId === planWorkoutId);
    },
    async decide() {
      throw new Error("unused");
    },
    async listActivities() {
      return input.activities;
    },
    async readProviderIdentities() {
      return input.providerEventId === undefined
        ? []
        : [{ planWorkoutId: ENDURANCE_ID, providerEventId: input.providerEventId }];
    },
    async readSyncStatus() {
      return { lastSuccessfulSyncAtMs: 1, awaitingSync: false };
    },
  };
}

const identity = {
  newId: () => `${"0".repeat(25)}4`,
  deviceId: async () => "device-1",
  stamp: () => ({ physicalMs: 10, counter: 0 }),
};

describe("WorkoutMatch", () => {
  it("trusts the provider pairing but never matches an explicitly marked race", async () => {
    const repository = memoryRepository({
      providerEventId: 42,
      activities: [
        {
          activityId: ACTIVITY_ID,
          providerActivityId: "i1",
          pairedEventId: 42,
          dateKey: 20260825,
          sport: "cycling",
          durationS: 5_400,
        },
      ],
    });
    await refreshPlanWorkoutMatches({
      planId: PLAN_ID,
      workouts: [
        workout({ id: ENDURANCE_ID }),
        workout({ id: RACE_ID, name: "Race", structureJson: '{"race":true}' }),
      ],
      startDateKey: 20260824,
      endDateKey: 20260830,
      repository,
      identity,
    });
    expect(repository.records).toEqual([
      expect.objectContaining({
        planWorkoutId: ENDURANCE_ID,
        source: "platform",
        decision: "confirmed",
        providerEventId: 42,
      }),
    ]);
  });

  it("requires confirmation for the fallback heuristic and projects honest five-state labels", async () => {
    const repository = memoryRepository({
      activities: [
        {
          activityId: ACTIVITY_ID,
          providerActivityId: "i1",
          pairedEventId: null,
          dateKey: 20260825,
          sport: "cycling",
          durationS: 5_100,
        },
      ],
    });
    const result = await refreshPlanWorkoutMatches({
      planId: PLAN_ID,
      workouts: [workout({ id: ENDURANCE_ID })],
      startDateKey: 20260824,
      endDateKey: 20260830,
      repository,
      identity,
    });
    expect(result.matches).toEqual([
      expect.objectContaining({ source: "heuristic", decision: "suggested" }),
    ]);
    expect(
      projectWorkoutMatches({
        workouts: [workout({ id: ENDURANCE_ID })],
        activities: result.activities,
        matches: result.matches,
        todayDateKey: 20260826,
        awaitingSync: false,
      }),
    ).toEqual([
      expect.objectContaining({
        workoutId: ENDURANCE_ID,
        activityId: ACTIVITY_ID,
        status: "decision-needed",
        requiresConfirmation: true,
      }),
    ]);
    expect(
      projectWorkoutMatches({
        workouts: [workout({ id: ENDURANCE_ID, dateKey: 20260824 })],
        activities: [],
        matches: [],
        todayDateKey: 20260826,
        awaitingSync: false,
      })[0],
    ).toMatchObject({ status: "missed" });
  });
});
