import { describe, expect, it, vi } from "vitest";
import {
  adoptProviderWorkoutEdit,
  planMirrorExternalId,
  planWorkoutDriftSnapshot,
  providerWorkoutDriftSnapshot,
  refreshPlanWorkoutDrifts,
  restorePlanWorkout,
  type PlanMirrorCalendarPort,
  type PlanMirrorEvent,
} from "../../src/index.js";
import type {
  PlanRecord,
  PlanRepository,
  PlanWorkoutDriftRecord,
  PlanWorkoutDriftRepository,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { canonicalJson } from "@enduragent/kernel/archive";

const PLAN_ID = `${"0".repeat(25)}1`;
const WORKOUT_ID = `${"0".repeat(25)}2`;
const DRIFT_ID = `${"0".repeat(25)}3`;

const plan: PlanRecord = {
  id: PLAN_ID,
  originId: null,
  name: "Gran Fondo Plan",
  primaryGoal: "Finish",
  startDateKey: 20260824,
  targetDateKey: null,
  status: "active",
  kind: "short_race_preparation",
  totalWeeks: 4,
  weekStartDay: 1,
  structureJson: "{}",
  createdAtMs: 1,
  updatedAtMs: 1,
  deviceId: "device-1",
  hlcPhysicalMs: 1,
  hlcCounter: 0,
};

const workout: PlanWorkoutRecord = {
  id: WORKOUT_ID,
  planId: PLAN_ID,
  dateKey: 20260826,
  sport: "cycling",
  name: "Threshold 4×8",
  durationS: 4_800,
  structureJson: '{"description":"Plan workout"}',
  origin: "coach",
  deviceId: "device-1",
  hlcPhysicalMs: 1,
  hlcCounter: 0,
};

function event(durationS = 3_300): PlanMirrorEvent {
  return {
    id: 42,
    dateKey: 20260826,
    externalId: planMirrorExternalId(PLAN_ID, WORKOUT_ID),
    category: "WORKOUT",
    name: "Threshold 4×8",
    durationS,
    description: "Intervals edit",
    workoutDoc: null,
    updated: "2026-08-26T10:00:00Z",
  };
}

function openDrift(): PlanWorkoutDriftRecord {
  return {
    id: DRIFT_ID,
    planId: PLAN_ID,
    planWorkoutId: WORKOUT_ID,
    providerEventId: 42,
    providerRevision: "2026-08-26T10:00:00Z",
    status: "detected",
    planSnapshotJson: canonicalJson(planWorkoutDriftSnapshot(workout)),
    providerSnapshotJson: canonicalJson(providerWorkoutDriftSnapshot(event())),
    detectedAtMs: 10,
    observedAtMs: 10,
    resolvedAtMs: null,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
  };
}

function driftRepository(initial?: PlanWorkoutDriftRecord): PlanWorkoutDriftRepository & {
  current(): PlanWorkoutDriftRecord | undefined;
} {
  let current = initial;
  return {
    current: () => current,
    async observe(record) {
      current = current === undefined ? record : { ...record, id: current.id };
      return current;
    },
    async read(id) {
      return current?.id === id ? current : undefined;
    },
    async readOpenForPlan(planId) {
      return current?.planId === planId && current.status === "detected" ? [current] : [];
    },
    async readOpenForWorkout(planWorkoutId) {
      return current?.planWorkoutId === planWorkoutId && current.status === "detected"
        ? current
        : undefined;
    },
    async resolve(input) {
      if (current === undefined) throw new Error("missing");
      current = { ...current, status: input.status, resolvedAtMs: input.resolvedAtMs };
      return current;
    },
    adopt: vi.fn(async (input) => {
      if (current === undefined) throw new Error("missing");
      current = { ...current, status: "adopted", resolvedAtMs: input.resolvedAtMs };
      return current;
    }),
  };
}

function planRepository(): PlanRepository {
  return {
    replace: vi.fn(),
    replaceNew: vi.fn(),
    endActive: vi.fn(),
    read: vi.fn(async () => plan),
    readByOriginId: vi.fn(),
    readLatest: vi.fn(async () => plan),
    listPlans: vi.fn(async () => []),
    readWorkouts: vi.fn(async () => [workout]),
    count: vi.fn(async () => 1),
    delete: vi.fn(),
  };
}

const identity = {
  newId: () => DRIFT_ID,
  deviceId: () => "device-1",
  stamp: () => ({ physicalMs: 20, counter: 0 }),
};

describe("Plan workout drift", () => {
  it("ignores Enduragent's own provider echo but asks once for changed content", async () => {
    const repository = driftRepository();
    const same = {
      ...event(4_800),
      description: "Plan workout",
      updated: "2026-08-26T09:59:00Z",
    };
    await expect(
      refreshPlanWorkoutDrifts(
        {
          plan,
          workouts: [workout],
          events: [same],
          todayDateKey: 20260826,
          windowEndDateKey: 20260901,
        },
        { repository, identity, now: () => 10 },
      ),
    ).resolves.toEqual([]);
    await refreshPlanWorkoutDrifts(
      {
        plan,
        workouts: [workout],
        events: [event()],
        todayDateKey: 20260826,
        windowEndDateKey: 20260901,
      },
      { repository, identity, now: () => 11 },
    );
    await refreshPlanWorkoutDrifts(
      {
        plan,
        workouts: [workout],
        events: [{ ...event(3_000), updated: "2026-08-26T10:05:00Z" }],
        todayDateKey: 20260826,
        windowEndDateKey: 20260901,
      },
      { repository, identity, now: () => 12 },
    );
    expect(repository.current()).toMatchObject({ id: DRIFT_ID, observedAtMs: 12 });
  });

  it("adopts the current Intervals workout without writing to the provider", async () => {
    const repository = driftRepository(openDrift());
    const updateEvent = vi.fn();
    const calendar: PlanMirrorCalendarPort = {
      listEvents: vi.fn(),
      createEvent: vi.fn(),
      deleteEvent: vi.fn(),
      readEvent: vi.fn(async () => event()),
      updateEvent,
    };
    await adoptProviderWorkoutEdit(
      { planId: PLAN_ID, workoutId: WORKOUT_ID, eventId: 42, todayDateKey: 20260826 },
      {
        repository,
        plans: planRepository(),
        calendar,
        identity,
        now: () => 20,
      },
    );
    expect(repository.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkout: workout,
        workout: expect.objectContaining({ durationS: 3_300, name: "Threshold 4×8" }),
        ledger: expect.objectContaining({
          kind: "drift-adopted",
          weekLoadBefore: null,
          weekLoadAfter: null,
        }),
      }),
    );
    expect(updateEvent).not.toHaveBeenCalled();
    expect(repository.current()).toMatchObject({ status: "adopted" });
  });

  it("restores and verifies the Plan workout before clearing attention", async () => {
    const repository = driftRepository(openDrift());
    let current = event();
    const updateEvent = vi.fn(async () => {
      current = { ...current, durationS: 4_800, description: "Plan workout" };
    });
    const calendar: PlanMirrorCalendarPort = {
      listEvents: vi.fn(),
      createEvent: vi.fn(),
      deleteEvent: vi.fn(),
      readEvent: vi.fn(async () => current),
      updateEvent,
    };
    await restorePlanWorkout(
      { planId: PLAN_ID, workoutId: WORKOUT_ID, eventId: 42, todayDateKey: 20260826 },
      { repository, plans: planRepository(), calendar, identity, now: () => 20 },
    );
    expect(updateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 42, durationS: 4_800 }),
    );
    expect(repository.current()).toMatchObject({ status: "restored" });
  });

  it("keeps drift unresolved when provider verification fails", async () => {
    const repository = driftRepository(openDrift());
    const calendar: PlanMirrorCalendarPort = {
      listEvents: vi.fn(),
      createEvent: vi.fn(),
      deleteEvent: vi.fn(),
      readEvent: vi.fn(async () => event()),
      updateEvent: vi.fn(),
    };
    await expect(
      restorePlanWorkout(
        { planId: PLAN_ID, workoutId: WORKOUT_ID, eventId: 42, todayDateKey: 20260826 },
        { repository, plans: planRepository(), calendar, identity, now: () => 20 },
      ),
    ).rejects.toMatchObject({ code: "verification-failed" });
    expect(repository.current()).toMatchObject({ status: "detected" });
  });

  it("revalidates a second outside edit instead of adopting a version the athlete did not see", async () => {
    const repository = driftRepository(openDrift());
    const changedAgain = {
      ...event(3_000),
      updated: "2026-08-26T10:05:00Z",
    };
    const calendar: PlanMirrorCalendarPort = {
      listEvents: vi.fn(),
      createEvent: vi.fn(),
      deleteEvent: vi.fn(),
      readEvent: vi.fn(async () => changedAgain),
      updateEvent: vi.fn(),
    };
    await expect(
      adoptProviderWorkoutEdit(
        { planId: PLAN_ID, workoutId: WORKOUT_ID, eventId: 42, todayDateKey: 20260826 },
        { repository, plans: planRepository(), calendar, identity, now: () => 21 },
      ),
    ).rejects.toMatchObject({ code: "invalid-provider-event" });
    expect(repository.adopt).not.toHaveBeenCalled();
    expect(repository.current()).toMatchObject({
      status: "detected",
      providerRevision: "2026-08-26T10:05:00Z",
      observedAtMs: 21,
    });
  });
});
