import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlanValidationError,
  PlanningDateError,
  createPlanRepository,
  createPlanReconciliationRepository,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;
const OTHER_PLAN_ID = `${"0".repeat(25)}2`;
const WORKOUT_ID = `${"0".repeat(25)}3`;
const CLEANUP_JOB_ID = `${"0".repeat(25)}4`;

function plan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: PLAN_ID,
    originId: "32cc7944-facd-4b56-b1a1-7dfe43e4bfe7",
    name: "Gran Fondo Plan",
    primaryGoal: "Finish in the front half",
    startDateKey: 20260709,
    targetDateKey: 20260930,
    status: "draft",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 4,
    structureJson: '{"phases":[]}',
    createdAtMs: 1,
    updatedAtMs: 2,
    deviceId: "device-1",
    hlcPhysicalMs: 2,
    hlcCounter: 0,
    ...overrides,
  };
}

function workout(overrides: Partial<PlanWorkoutRecord> = {}): PlanWorkoutRecord {
  return {
    id: WORKOUT_ID,
    planId: PLAN_ID,
    dateKey: 20260710,
    sport: "cycling",
    name: "Endurance",
    durationS: 5_400,
    structureJson: '{"sport":"cycling"}',
    origin: "coach",
    deviceId: "device-1",
    hlcPhysicalMs: 3,
    hlcCounter: 0,
    ...overrides,
  };
}

describe("Plan repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("replaces and reads a Plan with ordered Plan Workouts", async () => {
    const repository = createPlanRepository(store);
    await repository.replace(plan(), [
      workout({ id: `${"0".repeat(25)}4`, dateKey: 20260711, name: "Tempo" }),
      workout(),
    ]);
    await expect(repository.read(PLAN_ID)).resolves.toEqual(plan());
    await expect(
      repository.readByOriginId("32cc7944-facd-4b56-b1a1-7dfe43e4bfe7"),
    ).resolves.toEqual(plan());
    await expect(repository.readWorkouts(PLAN_ID)).resolves.toEqual([
      workout(),
      workout({ id: `${"0".repeat(25)}4`, dateKey: 20260711, name: "Tempo" }),
    ]);
    await expect(repository.count()).resolves.toBe(1);
  });

  it("rejects every persisted Plan invariant with a typed error", async () => {
    const repository = createPlanRepository(store);
    const cases: Array<[PlanRecord, PlanValidationError | PlanningDateError]> = [
      [plan({ id: "uuid" }), new PlanValidationError("invalid-id")],
      [
        plan({ status: "paused" as PlanRecord["status"] }),
        new PlanValidationError("invalid-status"),
      ],
      [plan({ kind: "other" as PlanRecord["kind"] }), new PlanValidationError("invalid-kind")],
      [plan({ kind: "short_race_preparation" }), new PlanValidationError("inconsistent-kind")],
      [plan({ totalWeeks: 0 }), new PlanValidationError("invalid-total-weeks")],
      [plan({ weekStartDay: 7 }), new PlanValidationError("invalid-week-start-day")],
      [plan({ weekStartDay: 1 }), new PlanValidationError("inconsistent-week-start-day")],
      [plan({ totalWeeks: 11 }), new PlanValidationError("target-outside-plan")],
    ];
    for (const [candidate, error] of cases) {
      await expect(repository.replace(candidate, [])).rejects.toEqual(error);
    }
    await expect(
      repository.replaceNew(plan({ startDateKey: 20260708, weekStartDay: 3 }), [], 20260709),
    ).rejects.toEqual(new PlanningDateError("start-before-today"));
    await expect(
      repository.replaceNew(
        plan({
          startDateKey: 20261005,
          targetDateKey: 20261004,
          weekStartDay: 1,
          kind: "short_race_preparation",
        }),
        [],
        20260709,
      ),
    ).rejects.toEqual(new PlanningDateError("start-after-target"));
  });

  it("accepts a valid short block even when race day lands in display week 12", async () => {
    const repository = createPlanRepository(store);
    const short = plan({
      targetDateKey: 20260929,
      kind: "short_race_preparation",
    });
    await expect(repository.replaceNew(short, [], 20260709)).resolves.toBeUndefined();
    await expect(repository.read(PLAN_ID)).resolves.toEqual(short);
  });

  it("enforces Plan Workout ownership and cascades deletion", async () => {
    const repository = createPlanRepository(store);
    await expect(
      store.run(
        `INSERT INTO plan_workout (
  id, plan_id, date_key, sport, name, duration_s, structure_json, origin,
  device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          WORKOUT_ID,
          OTHER_PLAN_ID,
          20260710,
          "cycling",
          "Endurance",
          5_400,
          "{}",
          "coach",
          "device-1",
          1,
          0,
        ],
      ),
    ).rejects.toThrow();
    await repository.replace(plan(), [workout()]);
    await repository.delete(PLAN_ID);
    await expect(repository.readWorkouts(PLAN_ID)).resolves.toEqual([]);
  });

  it("rejects invalid Plan Workout values before SQL", async () => {
    const repository = createPlanRepository(store);
    await expect(repository.replace(plan(), [workout({ durationS: 0 })])).rejects.toEqual(
      new PlanValidationError("invalid-workout"),
    );
    await expect(repository.replace(plan(), [workout({ dateKey: 20260708 })])).rejects.toEqual(
      new PlanValidationError("workout-outside-plan"),
    );
  });

  it("keeps the athlete's intervals.icu changes when an old-Plan End closes the Plan", async () => {
    const repository = createPlanRepository(store);
    await repository.replace(plan({ status: "active" }), [workout()]);
    await store.run(
      `INSERT INTO plan_week_delivery (plan_id,state_kind,state_json,close_choice_json,updated_at_ms)
      VALUES (?,'approved','{}',?,1)`,
      [PLAN_ID, JSON.stringify({ kind: "remove-them", ticked: [], commandId: "end-that-failed" })],
    );
    await repository.endActive({
      planId: PLAN_ID,
      cleanupJobId: CLEANUP_JOB_ID,
      windowStartDateKey: 20260710,
      windowEndDateKey: 20260930,
      updatedAtMs: 10,
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    });
    expect(await store.get("SELECT close_choice_json FROM plan_week_delivery")).toEqual({
      close_choice_json: '{"kind":"keep-them"}',
    });
  });

  it("ends locally and creates one durable cleanup job atomically", async () => {
    const repository = createPlanRepository(store);
    await repository.replace(plan({ status: "active" }), [workout()]);

    const first = await repository.endActive({
      planId: PLAN_ID,
      cleanupJobId: CLEANUP_JOB_ID,
      windowStartDateKey: 20260710,
      windowEndDateKey: 20260930,
      updatedAtMs: 10,
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    });
    const repeated = await repository.endActive({
      planId: PLAN_ID,
      cleanupJobId: `${"0".repeat(25)}5`,
      windowStartDateKey: 20260710,
      windowEndDateKey: 20260930,
      updatedAtMs: 11,
      deviceId: "device-1",
      hlcPhysicalMs: 11,
      hlcCounter: 0,
    });

    expect(first).toMatchObject({ plan: { status: "ended" }, cleanupJobId: CLEANUP_JOB_ID });
    expect(repeated.cleanupJobId).toBe(CLEANUP_JOB_ID);
    await expect(repository.readWorkouts(PLAN_ID)).resolves.toEqual([workout()]);
    await expect(
      createPlanReconciliationRepository(store).readLatestJob(PLAN_ID, "cleanup"),
    ).resolves.toMatchObject({ id: CLEANUP_JOB_ID, status: "pending" });
  });
});
