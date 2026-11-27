import { describe, expect, it, onTestFinished, vi } from "vitest";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  PlanCalendarRpcResultSchema,
  type PlanCalendarRpcParams,
} from "@enduragent/coach-contract";
import {
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createMemoryPlanCalendar } from "../../../apps/desktop/tests/helpers/plan-calendar-fake.js";
import { createPlanCalendarOperations } from "../src/plan-calendar-operations.js";

const MONDAY = 19980105;
const TODAY = 19980114;
const PLAN_ID = `${"0".repeat(25)}P`;

function workoutId(index: number): string {
  return `${"0".repeat(24)}${String(10 + index)}`;
}

function planWorkout(index: number, dateKey: number, durationS = 3_600): PlanWorkoutRecord {
  return {
    id: workoutId(index),
    planId: PLAN_ID,
    dateKey,
    sport: "Ride",
    name: `Endurance ${index}`,
    durationS,
    structureJson: "{}",
    origin: "coach",
    deviceId: "test-device",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
  };
}

interface Facts {
  readonly name: string;
  readonly load: number;
  readonly watts?: number;
  readonly heartRate?: number;
  readonly rpe?: number;
}

async function harness(options: { readonly plan: boolean } = { plan: true }) {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  onTestFinished(async () => {
    await store.close();
  });
  let sequence = 500;
  const changed = vi.fn(async (): Promise<void> => undefined);
  const operations = createPlanCalendarOperations({
    store,
    calendar: createMemoryPlanCalendar(),
    identity: {
      deviceId: async () => "rides-test-device",
      newUlid: () => String(++sequence).padStart(26, "0"),
      hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: ++sequence }),
    },
    applyChange: async () => ({ status: "rejected", reason: "stale-version" }) as never,
    todayDateKey: () => TODAY,
    now: () => 904_694_400_000,
    calendarConnected: () => true,
    dateKeyOfMs: () => TODAY,
    changed,
  });
  const workouts = [
    planWorkout(1, MONDAY),
    planWorkout(2, MONDAY + 2),
    planWorkout(3, MONDAY + 4),
    planWorkout(4, MONDAY + 7),
    planWorkout(5, MONDAY + 8),
  ];
  if (options.plan) {
    await createPlanRepository(store).replace(
      {
        id: PLAN_ID,
        originId: null,
        name: "Synthetic base",
        primaryGoal: "Ride longer",
        startDateKey: MONDAY,
        targetDateKey: null,
        status: "active",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 1,
        updatedAtMs: 1,
        deviceId: "test-device",
        hlcPhysicalMs: 1,
        hlcCounter: 0,
      },
      workouts,
    );
    await store.run(
      `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
       VALUES (?,'active',1,1,1,1,'test-device',1,0)`,
      [PLAN_ID],
    );
  }
  const ride = async (
    key: string,
    dateKey: number,
    seconds: number,
    facts: Facts | null,
    subSport: string | null = null,
  ) => {
    const day = String(dateKey);
    const start =
      Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T06:40:00Z`) / 1000;
    await store.run(
      "INSERT INTO workout (workout_key, start_utc, tz_offset_s, name, dedup_cluster_id) VALUES (?, ?, 3600, NULL, ?)",
      [key, start, key],
    );
    await store.run(
      `INSERT INTO session (session_key, workout_key, session_seq, sport, sub_sport, start_utc, tz_offset_s,
        local_date_key, moving_s, distance_m, is_transition)
       VALUES (?, ?, 0, 'cycling', ?, ?, 3600, ?, ?, 24100, 0)`,
      [key, key, subSport, start, dateKey, seconds],
    );
    if (facts === null) return;
    const artifact = `${key.slice(0, 63)}f`;
    const external = `i${key.slice(0, 6)}${dateKey}`;
    await store.run(
      "INSERT INTO source_artifact(artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s) VALUES(?,?,?,?,?,?,?,?)",
      [
        artifact,
        "intervals-icu",
        "activities",
        external,
        "snapshot",
        "d".repeat(64),
        `1998/${artifact}.json.gz`,
        start,
      ],
    );
    await store.run(
      "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json,artifact_key) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        `${key.slice(0, 63)}e`,
        key,
        key,
        "intervals-icu",
        external,
        "c".repeat(64),
        1,
        canonicalJson({
          activity: {
            id: external,
            name: facts.name,
            icu_training_load: facts.load,
            ...(facts.watts === undefined ? {} : { average_watts: facts.watts }),
            ...(facts.heartRate === undefined ? {} : { average_heartrate: facts.heartRate }),
            ...(facts.rpe === undefined ? {} : { icu_rpe: facts.rpe }),
            start_date_local: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T07:40:00`,
            type: "Ride",
          },
          concerns: {},
          dedup: {},
          schema_version: 1,
        }),
        artifact,
      ],
    );
  };
  const matches = createPlanWorkoutMatchRepository(store);
  let matchSequence = 0;
  const match = async (
    planWorkout: number,
    activityId: string,
    dateKey: number,
    seconds: number,
    decision: "confirmed" | "suggested",
  ) => {
    await matches.observe({
      id: `${"0".repeat(24)}M${++matchSequence}`,
      planId: PLAN_ID,
      planWorkoutId: workoutId(planWorkout),
      activityId,
      providerActivityId: null,
      providerEventId: null,
      source: "heuristic",
      decision,
      activityDateKey: dateKey,
      activitySport: "cycling",
      activityDurationS: seconds,
      observedAtMs: 1,
      decidedAtMs: decision === "confirmed" ? 1 : null,
      deviceId: "test-device",
      hlcPhysicalMs: 1,
      hlcCounter: 0,
    });
  };
  const call = async (request: PlanCalendarRpcParams) =>
    PlanCalendarRpcResultSchema.parse(await operations["plan.calendar"](request));
  const rides = async () => {
    const read = await call({ action: "rides", startDateKey: 19971229, endDateKey: TODAY });
    if (read.status !== "rides") throw new Error("Expected rides");
    return read;
  };
  const calendarOutcome = async (planWorkout: number) => {
    const read = await call({ action: "read", startDateKey: MONDAY, endDateKey: TODAY + 7 });
    if (read.status !== "calendar" || read.plan === null) throw new Error("Expected a Plan");
    return read.plan.workouts.find((workout) => workout.id === workoutId(planWorkout))?.outcome
      .kind;
  };
  const decide = (
    activityId: string,
    decision: Extract<PlanCalendarRpcParams, { action: "decide-ride" }>["decision"],
  ) => call({ action: "decide-ride", planId: PLAN_ID, activityId, decision });
  return { store, changed, ride, match, matches, rides, calendarOutcome, decide, call };
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

describe("the Activity review read", () => {
  it("lists rides newest first with their facts, outcome and Training Weeks", async () => {
    const test = await harness();
    await test.ride(A, MONDAY, 3_700, { name: "Synthetic endurance", load: 52 }, "road");
    await test.ride(B, MONDAY + 2, 2_400, {
      name: "Threshold 4x8",
      load: 70,
      watts: 214.4,
      heartRate: 151.6,
      rpe: 7,
    });
    await test.ride(
      C,
      MONDAY + 7,
      3_120,
      { name: "Road ride", load: 38, watts: 181 },
      "indoor_cycling",
    );
    await test.ride(D, MONDAY + 5, 3_300, null);
    await test.match(1, A, MONDAY, 3_700, "confirmed");
    await test.match(2, B, MONDAY + 2, 2_400, "confirmed");
    await test.match(4, C, MONDAY + 7, 3_120, "suggested");
    const read = await test.rides();
    expect(read.todayDateKey).toBe(TODAY);
    expect(read.plan?.weeks).toHaveLength(12);
    expect(read.plan?.planId).toBe(PLAN_ID);
    expect(
      read.plan?.weeks.slice(0, 4).map((week) => [week.index, week.startDateKey, week.endDateKey]),
    ).toEqual([
      [1, MONDAY, MONDAY + 6],
      [2, MONDAY + 7, MONDAY + 13],
      [3, 19980119, 19980125],
      [4, 19980126, 19980201],
    ]);
    expect(read.rides.map((ride) => [ride.activityId, ride.match.kind])).toEqual([
      [C, "suggested"],
      [D, "none"],
      [B, "confirmed"],
      [A, "confirmed"],
    ]);
    const [suggested, extra, differently, asPlanned] = read.rides;
    expect(suggested).toMatchObject({
      dateKey: MONDAY + 7,
      startEpochSeconds: Date.parse("1998-01-12T06:40:00Z") / 1000,
      timezoneOffsetSeconds: 3600,
      name: "Road ride",
      kind: "indoor",
      fromIntervals: true,
      durationS: 3_120,
      distanceM: 24_100,
      load: 38,
      averagePowerW: 181,
      averageHeartRateBpm: null,
      perceivedExertion: null,
      match: {
        kind: "suggested",
        planWorkoutId: workoutId(4),
        name: "Endurance 4",
        dateKey: MONDAY + 7,
        durationS: 3_600,
      },
    });
    expect(suggested?.otherWorkouts.map((workout) => workout.planWorkoutId)).toEqual([
      workoutId(3),
      workoutId(5),
    ]);
    expect(extra).toMatchObject({ name: null, kind: "other", fromIntervals: false, load: null });
    expect(differently).toMatchObject({
      averagePowerW: 214,
      averageHeartRateBpm: 152,
      perceivedExertion: 7,
      match: { kind: "confirmed", outcome: "done-differently", by: "you", name: "Endurance 2" },
    });
    expect(asPlanned).toMatchObject({
      kind: "road",
      match: { kind: "confirmed", outcome: "done-as-planned", by: "you" },
    });
  });

  it("gives rides no match and no Training Weeks without a Plan", async () => {
    const test = await harness({ plan: false });
    await test.ride(A, TODAY, 3_300, { name: "Café ride", load: 41 });
    const read = await test.rides();
    expect(read.plan).toBeNull();
    expect(read.rides).toMatchObject([
      { activityId: A, name: "Café ride", match: { kind: "none" }, otherWorkouts: [] },
    ]);
  });
});

describe("deciding a ride", () => {
  it("confirms the suggestion, and the Calendar shows the workout done instead of asking", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_480, { name: "Road ride", load: 38 });
    await test.match(4, C, MONDAY + 7, 3_480, "suggested");
    expect(await test.calendarOutcome(4)).toBe("is-this-it");
    const result = await test.decide(C, { kind: "confirm", planWorkoutId: workoutId(4) });
    expect(result).toMatchObject({
      status: "ride",
      ride: {
        activityId: C,
        match: { kind: "confirmed", planWorkoutId: workoutId(4), outcome: "done-as-planned" },
      },
    });
    expect(test.changed).toHaveBeenCalledOnce();
    expect(await test.calendarOutcome(4)).toBe("done-as-planned");
  });

  it("turns down the suggestion: the ride counts as Extra and the Calendar stops asking", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_120, { name: "Road ride", load: 38 });
    await test.match(4, C, MONDAY + 7, 3_120, "suggested");
    expect(await test.decide(C, { kind: "extra" })).toMatchObject({
      status: "ride",
      ride: { match: { kind: "none" } },
    });
    expect(await test.calendarOutcome(4)).toBe("missed");
  });

  it("moves a confirmed match to another day's workout, freeing the first one", async () => {
    const test = await harness();
    await test.ride(B, MONDAY + 2, 3_600, { name: "Threshold", load: 70 });
    await test.match(2, B, MONDAY + 2, 3_600, "confirmed");
    const result = await test.decide(B, { kind: "rematch", planWorkoutId: workoutId(3) });
    expect(result).toMatchObject({
      status: "ride",
      ride: {
        match: { kind: "confirmed", planWorkoutId: workoutId(3), by: "you" },
        otherWorkouts: [{ planWorkoutId: workoutId(1) }, { planWorkoutId: workoutId(2) }],
      },
    });
    expect(await test.calendarOutcome(2)).toBe("missed");
    expect(await test.calendarOutcome(3)).toBe("moved");
    expect(await test.matches.readForWorkout(workoutId(3))).toMatchObject([
      { activityId: B, decision: "confirmed", source: "heuristic", activityDurationS: 3_600 },
    ]);
  });

  it("matches a ride again to a workout it was once turned down for", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_480, { name: "Road ride", load: 38 });
    await test.match(4, C, MONDAY + 7, 3_480, "suggested");
    await test.decide(C, { kind: "extra" });
    expect(await test.decide(C, { kind: "rematch", planWorkoutId: workoutId(4) })).toMatchObject({
      status: "ride",
      ride: { match: { kind: "confirmed", planWorkoutId: workoutId(4) } },
    });
    expect(await test.calendarOutcome(4)).toBe("done-as-planned");
  });

  it("keeps one ride per workout: confirming turns down the workout's other suggestions", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_120, { name: "Road ride", load: 38 });
    await test.ride(E, MONDAY + 7, 1_800, { name: "Spin", load: 12 });
    await test.match(4, C, MONDAY + 7, 3_120, "suggested");
    await test.match(4, E, MONDAY + 7, 1_800, "suggested");
    await test.decide(C, { kind: "confirm", planWorkoutId: workoutId(4) });
    const read = await test.rides();
    expect(read.rides.find((ride) => ride.activityId === E)?.match).toEqual({ kind: "none" });
    expect(read.rides.find((ride) => ride.activityId === E)?.otherWorkouts).not.toContainEqual(
      expect.objectContaining({ planWorkoutId: workoutId(4) }),
    );
  });

  it("refuses a decision that no longer fits, and changes nothing", async () => {
    const test = await harness();
    await test.ride(A, MONDAY, 3_700, { name: "Endurance", load: 52 });
    await test.ride(C, MONDAY + 2, 3_120, { name: "Road ride", load: 38 });
    await test.match(1, A, MONDAY, 3_700, "confirmed");
    expect(await test.decide(C, { kind: "confirm", planWorkoutId: workoutId(2) })).toEqual({
      status: "refused",
      reason: "match-changed",
    });
    expect(await test.decide(C, { kind: "rematch", planWorkoutId: workoutId(1) })).toEqual({
      status: "refused",
      reason: "match-changed",
    });
    expect(
      await test.call({
        action: "decide-ride",
        planId: `${"0".repeat(25)}Q`,
        activityId: C,
        decision: { kind: "extra" },
      }),
    ).toEqual({ status: "refused", reason: "no-active-plan" });
    expect(test.changed).not.toHaveBeenCalled();
    expect(await test.calendarOutcome(1)).toBe("done-as-planned");
  });
});
