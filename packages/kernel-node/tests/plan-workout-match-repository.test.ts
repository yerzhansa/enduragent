import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlanWorkoutMatchValidationError,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  type PlanRecord,
  type PlanWorkoutMatchRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;
const WORKOUT_ID = `${"0".repeat(25)}2`;
const MATCH_ID = `${"0".repeat(25)}3`;
const ACTIVITY_ID = "a".repeat(64);

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
  dateKey: 20260825,
  sport: "cycling",
  name: "Endurance",
  durationS: 5_400,
  structureJson: "{}",
  origin: "coach",
  deviceId: "device-1",
  hlcPhysicalMs: 1,
  hlcCounter: 0,
};

function suggestion(overrides: Partial<PlanWorkoutMatchRecord> = {}): PlanWorkoutMatchRecord {
  return {
    id: MATCH_ID,
    planId: PLAN_ID,
    planWorkoutId: WORKOUT_ID,
    activityId: ACTIVITY_ID,
    providerActivityId: "i123",
    providerEventId: null,
    source: "heuristic",
    decision: "suggested",
    activityDateKey: 20260825,
    activitySport: "cycling",
    activityDurationS: 5_100,
    observedAtMs: 10,
    decidedAtMs: null,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
    ...overrides,
  };
}

describe("Plan WorkoutMatch repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanRepository(store).replace(plan, [workout]);
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists athlete confirmation and never overwrites it with another heuristic observation", async () => {
    const repository = createPlanWorkoutMatchRepository(store);
    await expect(repository.observe(suggestion())).resolves.toEqual(suggestion());
    const confirmed = await repository.decide({
      id: MATCH_ID,
      decision: "confirmed",
      decidedAtMs: 11,
      deviceId: "device-1",
      hlcPhysicalMs: 11,
      hlcCounter: 0,
    });
    expect(confirmed).toMatchObject({ decision: "confirmed", decidedAtMs: 11 });
    await expect(
      repository.observe(suggestion({ observedAtMs: 12, hlcPhysicalMs: 12 })),
    ).resolves.toMatchObject({ decision: "confirmed", decidedAtMs: 11 });
    await expect(
      repository.decide({
        id: MATCH_ID,
        decision: "unpaired",
        decidedAtMs: 13,
        deviceId: "device-1",
        hlcPhysicalMs: 13,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanWorkoutMatchValidationError("invalid-transition"));
  });

  it("lets the athlete take back a confirmation, and confirm a refused pairing later", async () => {
    const repository = createPlanWorkoutMatchRepository(store);
    await repository.observe(suggestion());
    const stamp = (at: number) => ({
      id: MATCH_ID,
      decidedAtMs: at,
      deviceId: "device-1",
      hlcPhysicalMs: at,
      hlcCounter: 0,
    });
    await repository.decide({ ...stamp(11), decision: "confirmed" });
    await expect(repository.decide({ ...stamp(12), decision: "rejected" })).resolves.toMatchObject({
      decision: "rejected",
      decidedAtMs: 12,
    });
    await expect(
      repository.observe(suggestion({ observedAtMs: 13, hlcPhysicalMs: 13 })),
    ).resolves.toMatchObject({ decision: "rejected", decidedAtMs: 12 });
    await expect(repository.decide({ ...stamp(14), decision: "confirmed" })).resolves.toMatchObject(
      { decision: "confirmed", decidedAtMs: 14 },
    );
  });

  it("never adds a second confirmed match, or a suggestion, for a workout or ride already confirmed", async () => {
    const second = { ...workout, id: `${"0".repeat(25)}5`, dateKey: 20260826 };
    await createPlanRepository(store).replace(plan, [workout, second]);
    const repository = createPlanWorkoutMatchRepository(store);
    const otherRide = "b".repeat(64);
    const confirmedAt = { decidedAtMs: 10 };
    await repository.observe(
      suggestion({ decision: "confirmed", decidedAtMs: confirmedAt.decidedAtMs }),
    );
    await expect(
      repository.observe(suggestion({ id: `${"0".repeat(25)}6`, activityId: otherRide })),
    ).resolves.toBeNull();
    await expect(
      repository.observe(suggestion({ id: `${"0".repeat(25)}7`, planWorkoutId: second.id })),
    ).resolves.toBeNull();
    await expect(
      repository.observe(
        suggestion({
          id: `${"0".repeat(25)}8`,
          planWorkoutId: second.id,
          source: "platform",
          providerEventId: 77,
          decision: "confirmed",
          decidedAtMs: 10,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      repository.observe(
        suggestion({ id: `${"0".repeat(25)}9`, planWorkoutId: second.id, activityId: otherRide }),
      ),
    ).resolves.toMatchObject({ decision: "suggested" });
    expect((await repository.readForPlan(PLAN_ID)).map((row) => row.id)).toEqual([
      MATCH_ID,
      `${"0".repeat(25)}9`,
    ]);
  });

  it("refuses to confirm a ride for a workout another ride has, or a second workout for a ride", async () => {
    const second = { ...workout, id: `${"0".repeat(25)}5`, dateKey: 20260826 };
    await createPlanRepository(store).replace(plan, [workout, second]);
    const repository = createPlanWorkoutMatchRepository(store);
    const otherRide = "b".repeat(64);
    const otherRideMatch = `${"0".repeat(25)}6`;
    const secondWorkoutMatch = `${"0".repeat(25)}7`;
    await repository.observe(suggestion());
    await repository.observe(suggestion({ id: otherRideMatch, activityId: otherRide }));
    await repository.observe(suggestion({ id: secondWorkoutMatch, planWorkoutId: second.id }));
    const decide = (id: string, decision: "confirmed" | "rejected", at: number) =>
      repository.decide({
        id,
        decision,
        decidedAtMs: at,
        deviceId: "device-1",
        hlcPhysicalMs: at,
        hlcCounter: 0,
      });
    await decide(MATCH_ID, "confirmed", 11);
    await expect(decide(otherRideMatch, "confirmed", 12)).rejects.toEqual(
      new PlanWorkoutMatchValidationError("already-confirmed"),
    );
    await expect(decide(secondWorkoutMatch, "confirmed", 12)).rejects.toEqual(
      new PlanWorkoutMatchValidationError("already-confirmed"),
    );
    expect((await repository.readForPlan(PLAN_ID)).map((row) => [row.id, row.decision])).toEqual([
      [MATCH_ID, "confirmed"],
      [otherRideMatch, "suggested"],
      [secondWorkoutMatch, "suggested"],
    ]);
    await decide(MATCH_ID, "rejected", 13);
    await expect(decide(otherRideMatch, "confirmed", 14)).resolves.toMatchObject({
      decision: "confirmed",
    });
  });

  it("reads canonical activities and reports stale Intervals sync honestly", async () => {
    const repository = createPlanWorkoutMatchRepository(store);
    await store.run(
      "INSERT INTO workout(workout_key,start_utc,is_multisport,dedup_cluster_id) VALUES(?,?,?,?)",
      ["b".repeat(64), 1, 0, "cluster-1"],
    );
    await store.run(
      `INSERT INTO session(
session_key,workout_key,session_seq,sport,start_utc,local_date_key,elapsed_s,is_transition
) VALUES(?,?,?,?,?,?,?,?)`,
      [ACTIVITY_ID, "b".repeat(64), 0, "cycling", 1, 20260825, 5_100, 0],
    );
    await expect(repository.listActivities(20260824, 20260830)).resolves.toEqual([
      {
        activityId: ACTIVITY_ID,
        providerActivityId: null,
        dateKey: 20260825,
        sport: "cycling",
        durationS: 5_100,
        pairedEventId: null,
      },
    ]);
    await store.run(
      "INSERT INTO sync_failure(source,severity,detail,logical_ordinal) VALUES(?,?,?,?)",
      ["intervals-icu", "warn", "source temporarily unavailable", 1],
    );
    await expect(repository.readSyncStatus()).resolves.toEqual({
      lastSuccessfulSyncAtMs: null,
      awaitingSync: true,
    });
  });
});
