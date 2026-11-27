import { describe, expect, it, onTestFinished, vi } from "vitest";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  PlanCalendarRpcResultSchema,
  type PlanCalendarRpcParams,
} from "@enduragent/coach-contract";
import { refreshPlanWorkoutMatches } from "@enduragent/engine";
import { encodeIcuCopy } from "@enduragent/engine/calendar";
import {
  createPlanCalendarMirrorRepository,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  type PlanWorkoutMatchRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
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

function planWorkout(
  index: number,
  dateKey: number,
  durationS: number | null = 3_600,
  structureJson = "{}",
): PlanWorkoutRecord {
  return {
    id: workoutId(index),
    planId: PLAN_ID,
    dateKey,
    sport: "Ride",
    name: `Endurance ${index}`,
    durationS,
    structureJson,
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
  readonly pairedEventId?: number;
}

async function harness(
  options: { readonly plan: boolean; readonly extra?: readonly PlanWorkoutRecord[] } = {
    plan: true,
  },
) {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  onTestFinished(async () => {
    await store.close();
  });
  let sequence = 500;
  const changed = vi.fn(async (): Promise<void> => undefined);
  let beforeSessionRead: (() => Promise<void>) | null = null;
  const watched = new Proxy(store, {
    get(target, property) {
      if (property === "get") {
        return async (sql: string, params?: Parameters<typeof target.get>[1]) => {
          const hook = beforeSessionRead;
          if (hook !== null && sql.includes("FROM session WHERE session_key=? AND sport=")) {
            beforeSessionRead = null;
            await hook();
          }
          return target.get(sql, params);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const identity = {
    deviceId: async () => "rides-test-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: ++sequence }),
  };
  const operations = createPlanCalendarOperations({
    store: watched,
    calendar: createMemoryPlanCalendar(),
    identity,
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
    ...(options.extra ?? []),
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
    session: { readonly sport?: string; readonly startUtc?: string } = {},
  ) => {
    const day = String(dateKey);
    const start =
      Date.parse(
        session.startUtc ?? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T06:40:00Z`,
      ) / 1000;
    await store.run(
      "INSERT INTO workout (workout_key, start_utc, tz_offset_s, name, dedup_cluster_id) VALUES (?, ?, 3600, NULL, ?)",
      [key, start, key],
    );
    await store.run(
      `INSERT INTO session (session_key, workout_key, session_seq, sport, sub_sport, start_utc, tz_offset_s,
        local_date_key, moving_s, distance_m, is_transition)
       VALUES (?, ?, 0, ?, ?, ?, 3600, ?, ?, 24100, 0)`,
      [key, key, session.sport ?? "cycling", subSport, start, dateKey, seconds],
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
            ...(facts.pairedEventId === undefined ? {} : { paired_event_id: facts.pairedEventId }),
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
    source: "heuristic" | "platform" = "heuristic",
  ) =>
    matches.observe({
      id: `${"0".repeat(24)}M${++matchSequence}`,
      planId: PLAN_ID,
      planWorkoutId: workoutId(planWorkout),
      activityId,
      providerActivityId: source === "platform" ? "i12345" : null,
      providerEventId: source === "platform" ? 777 : null,
      source,
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
  const decide = (activityId: string, expected: Expected, decision: Decision) =>
    call({ action: "decide-ride", planId: PLAN_ID, activityId, expected, decision });
  const onIntervals = (planWorkout: number, dateKey: number, eventId: number) =>
    createPlanCalendarMirrorRepository(store).writeCopy({
      planId: PLAN_ID,
      planWorkoutId: workoutId(planWorkout),
      dateKey,
      stateKind: "on-icu",
      stateJson: encodeIcuCopy({
        kind: "on-icu",
        baseline: {
          eventId,
          dateKey,
          planFingerprint: "synthetic",
          readBack: { fingerprint: "synthetic", updated: "1998-01-01T00:00:00Z" },
          owner: "plan",
        },
      }),
      lastWrite: { kind: "ok" },
      updatedAtMs: 1,
    });
  const removed = (planWorkout: number, dateKey: number) =>
    createPlanCalendarMirrorRepository(store).writeCopy({
      planId: PLAN_ID,
      planWorkoutId: workoutId(planWorkout),
      dateKey,
      stateKind: "removed-by-you",
      stateJson: encodeIcuCopy({ kind: "removed-by-you" }),
      lastWrite: { kind: "none" },
      updatedAtMs: 1,
    });
  const interleave = (hook: () => Promise<void>) => {
    beforeSessionRead = hook;
  };
  return {
    store,
    identity,
    changed,
    ride,
    match,
    matches,
    rides,
    calendarOutcome,
    decide,
    call,
    interleave,
    onIntervals,
    removed,
  };
}

type DecideParams = Extract<PlanCalendarRpcParams, { action: "decide-ride" }>;
type Expected = DecideParams["expected"];
type Decision = DecideParams["decision"];

const NONE: Expected = { kind: "none" };
const suggested = (index: number): Expected => ({
  kind: "suggested",
  planWorkoutId: workoutId(index),
});
const confirmed = (index: number): Expected => ({
  kind: "confirmed",
  planWorkoutId: workoutId(index),
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const F = "f".repeat(64);

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
  it("suggests a match for a ride in an earlier Training Week the first time it is read", async () => {
    const test = await harness();
    await test.ride(A, MONDAY + 4, 3_500, { name: "Sunday ride", load: 40 });
    expect(await test.calendarOutcome(3)).toBe("missed");
    expect((await test.rides()).rides[0]?.match).toMatchObject({
      kind: "suggested",
      planWorkoutId: workoutId(3),
    });
    expect(await test.calendarOutcome(3)).toBe("is-this-it");
  });

  it("keeps the newest 120 days of a longer range", async () => {
    const test = await harness();
    await test.ride(A, MONDAY, 3_600, { name: "Newest", load: 40 });
    await test.ride(B, 19970901, 3_600, { name: "Too old", load: 40 });
    const read = await test.call({ action: "rides", startDateKey: 19970801, endDateKey: TODAY });
    expect(read.status === "rides" ? read.rides.map((ride) => ride.activityId) : read).toEqual([A]);
  });

  it("leaves out sessions that are not rides, and suggests nothing for them", async () => {
    const test = await harness();
    await test.ride(A, MONDAY + 4, 3_500, { name: "Run", load: 40 }, null, { sport: "running" });
    expect((await test.rides()).rides).toEqual([]);
    expect(await test.matches.readForPlan(PLAN_ID)).toEqual([]);
  });

  it("puts a ride on its local day when it starts the evening before in UTC", async () => {
    const test = await harness();
    await test.ride(A, TODAY, 3_500, { name: "Early ride", load: 40 }, null, {
      startUtc: "1998-01-13T23:30:00Z",
    });
    expect((await test.rides()).rides).toMatchObject([
      {
        activityId: A,
        dateKey: TODAY,
        startEpochSeconds: Date.parse("1998-01-13T23:30:00Z") / 1000,
        timezoneOffsetSeconds: 3600,
      },
    ]);
  });

  it("offers only nearby, free, non-race Plan Workouts the athlete kept", async () => {
    const test = await harness({
      plan: true,
      extra: [
        planWorkout(6, MONDAY + 1, 7_200, '{"race":true}'),
        planWorkout(7, MONDAY + 3),
        planWorkout(8, MONDAY + 20),
      ],
    });
    await createPlanCalendarMirrorRepository(test.store).writeCopy({
      planId: PLAN_ID,
      planWorkoutId: workoutId(7),
      dateKey: MONDAY + 3,
      stateKind: "removed-by-you",
      stateJson: encodeIcuCopy({ kind: "removed-by-you" }),
      lastWrite: { kind: "none" },
      updatedAtMs: 1,
    });
    await test.ride(A, MONDAY, 3_600, { name: "Endurance", load: 40 });
    await test.ride(B, MONDAY + 2, 3_600, { name: "Threshold", load: 60 });
    await test.match(2, B, MONDAY + 2, 3_600, "confirmed");
    await test.match(1, A, MONDAY, 3_600, "confirmed");
    const ride = (await test.rides()).rides.find((entry) => entry.activityId === A);
    expect(ride?.otherWorkouts.map((workout) => workout.planWorkoutId)).toEqual([]);
    for (const target of [6, 7, 8, 2]) {
      expect(
        await test.decide(A, confirmed(1), { kind: "rematch", planWorkoutId: workoutId(target) }),
      ).toEqual({ status: "refused", reason: "match-changed" });
    }
    expect(await test.calendarOutcome(1)).toBe("done-as-planned");
  });
});

describe("deciding a ride", () => {
  it("confirms the suggestion, and the Calendar shows the workout done instead of asking", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_480, { name: "Road ride", load: 38 });
    await test.match(4, C, MONDAY + 7, 3_480, "suggested");
    expect(await test.calendarOutcome(4)).toBe("is-this-it");
    const result = await test.decide(C, suggested(4), {
      kind: "confirm",
      planWorkoutId: workoutId(4),
    });
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
    expect(await test.decide(C, suggested(4), { kind: "extra" })).toMatchObject({
      status: "ride",
      ride: { match: { kind: "none" } },
    });
    expect(await test.calendarOutcome(4)).toBe("missed");
  });

  it("moves a confirmed match to another day's workout, freeing the first one", async () => {
    const test = await harness();
    await test.ride(B, MONDAY + 2, 3_600, { name: "Threshold", load: 70 });
    await test.match(2, B, MONDAY + 2, 3_600, "confirmed");
    const result = await test.decide(B, confirmed(2), {
      kind: "rematch",
      planWorkoutId: workoutId(3),
    });
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
    await test.decide(C, suggested(4), { kind: "extra" });
    expect(
      await test.decide(C, NONE, { kind: "rematch", planWorkoutId: workoutId(4) }),
    ).toMatchObject({
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
    await test.decide(C, suggested(4), { kind: "confirm", planWorkoutId: workoutId(4) });
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
    expect(
      await test.decide(C, suggested(2), { kind: "confirm", planWorkoutId: workoutId(2) }),
    ).toEqual({
      status: "refused",
      reason: "match-changed",
    });
    expect(await test.decide(C, NONE, { kind: "rematch", planWorkoutId: workoutId(1) })).toEqual({
      status: "refused",
      reason: "match-changed",
    });
    expect(
      await test.call({
        action: "decide-ride",
        planId: `${"0".repeat(25)}Q`,
        activityId: C,
        expected: NONE,
        decision: { kind: "extra" },
      }),
    ).toEqual({ status: "refused", reason: "no-active-plan" });
    expect(test.changed).not.toHaveBeenCalled();
    expect(await test.calendarOutcome(1)).toBe("done-as-planned");
  });
  it("refuses a stale answer when the match changed meanwhile, and keeps the newer match", async () => {
    const test = await harness({ plan: true, extra: [planWorkout(6, MONDAY)] });
    await test.ride(A, MONDAY, 3_600, { name: "Endurance", load: 40 });
    await test.match(6, A, MONDAY, 3_600, "suggested");
    await test.match(1, A, MONDAY, 3_600, "confirmed", "platform");
    expect(
      await test.decide(A, suggested(6), { kind: "confirm", planWorkoutId: workoutId(6) }),
    ).toEqual({ status: "refused", reason: "match-changed" });
    expect(await test.decide(A, suggested(6), { kind: "extra" })).toEqual({
      status: "refused",
      reason: "match-changed",
    });
    expect(
      (await test.matches.readForWorkout(workoutId(1))).map((row) => [row.source, row.decision]),
    ).toEqual([["platform", "confirmed"]]);
    expect(test.changed).not.toHaveBeenCalled();
  });

  it("refuses a stale No after the Plan page confirmed the match meanwhile", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_480, { name: "Road ride", load: 38 });
    const row = await test.match(4, C, MONDAY + 7, 3_480, "suggested");
    if (row === null) throw new Error("Expected a suggestion");
    await test.matches.decide({
      id: row.id,
      decision: "confirmed",
      decidedAtMs: 2,
      deviceId: "plan-page",
      hlcPhysicalMs: 2,
      hlcCounter: 0,
    });
    expect(await test.decide(C, suggested(4), { kind: "extra" })).toEqual({
      status: "refused",
      reason: "match-changed",
    });
    expect(await test.calendarOutcome(4)).toBe("done-as-planned");
  });

  it("stops asking about a ride once another ride is confirmed for its workout", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_480, { name: "Road ride", load: 38 });
    await test.ride(E, MONDAY + 7, 1_800, { name: "Spin", load: 12 });
    const row = await test.match(4, C, MONDAY + 7, 3_480, "suggested");
    await test.match(4, E, MONDAY + 7, 1_800, "suggested");
    if (row === null) throw new Error("Expected a suggestion");
    await test.matches.decide({
      id: row.id,
      decision: "confirmed",
      decidedAtMs: 2,
      deviceId: "plan-page",
      hlcPhysicalMs: 2,
      hlcCounter: 0,
    });
    const spin = (await test.rides()).rides.find((ride) => ride.activityId === E);
    expect(spin?.match).toEqual({ kind: "none" });
    expect(spin?.otherWorkouts.map((workout) => workout.planWorkoutId)).not.toContain(workoutId(4));
    expect(
      await test.decide(E, suggested(4), { kind: "confirm", planWorkoutId: workoutId(4) }),
    ).toEqual({ status: "refused", reason: "match-changed" });
    expect(await test.calendarOutcome(4)).toBe("done-as-planned");
  });

  it("unpairs a match made in intervals.icu for No, and for another day's workout", async () => {
    const test = await harness();
    await test.ride(A, MONDAY, 3_600, { name: "Endurance", load: 40 });
    await test.ride(B, MONDAY + 2, 3_600, { name: "Threshold", load: 60 });
    await test.match(1, A, MONDAY, 3_600, "confirmed", "platform");
    await test.match(2, B, MONDAY + 2, 3_600, "confirmed", "platform");
    expect(await test.decide(A, confirmed(1), { kind: "extra" })).toMatchObject({
      status: "ride",
      ride: { match: { kind: "none" } },
    });
    expect(
      await test.decide(B, confirmed(2), { kind: "rematch", planWorkoutId: workoutId(3) }),
    ).toMatchObject({
      status: "ride",
      ride: { match: { kind: "confirmed", planWorkoutId: workoutId(3), by: "you" } },
    });
    expect(
      (await test.matches.readForPlan(PLAN_ID)).map((row) => [
        row.planWorkoutId,
        row.source,
        row.decision,
      ]),
    ).toEqual([
      [workoutId(1), "platform", "unpaired"],
      [workoutId(2), "platform", "unpaired"],
      [workoutId(3), "heuristic", "confirmed"],
    ]);
    expect((await test.rides()).rides.map((ride) => ride.match.kind)).toEqual([
      "confirmed",
      "none",
    ]);
    expect(await test.calendarOutcome(1)).toBe("missed");
    expect(await test.calendarOutcome(2)).toBe("missed");
  });

  it("does not bring a turned-down suggestion back when the list is read again", async () => {
    const test = await harness();
    await test.ride(C, MONDAY + 7, 3_480, { name: "Road ride", load: 38 });
    expect((await test.rides()).rides[0]?.match).toMatchObject({ kind: "suggested" });
    await test.decide(C, suggested(4), { kind: "extra" });
    expect((await test.rides()).rides[0]?.match).toEqual({ kind: "none" });
    expect((await test.rides()).rides[0]?.match).toEqual({ kind: "none" });
    expect(await test.calendarOutcome(4)).toBe("missed");
  });

  it("keeps a workout to one ride when the planning read runs on a list read before the answer", async () => {
    const test = await harness();
    await test.ride(B, MONDAY + 2, 3_600, { name: "Threshold", load: 60 });
    await test.ride(F, MONDAY + 4, 3_500, { name: "Other ride", load: 50 });
    await test.match(2, B, MONDAY + 2, 3_600, "suggested");
    const before = await test.matches.readForPlan(PLAN_ID);
    await test.decide(B, suggested(2), { kind: "rematch", planWorkoutId: workoutId(3) });
    const stale: PlanWorkoutMatchRepository = {
      ...test.matches,
      readForPlan: async () => before,
    };
    await refreshPlanWorkoutMatches({
      planId: PLAN_ID,
      workouts: await createLegacyPlanRepository(test.store).readWorkouts(PLAN_ID),
      startDateKey: MONDAY,
      endDateKey: MONDAY + 6,
      repository: stale,
      identity: {
        newId: () => test.identity.newUlid(),
        deviceId: () => test.identity.deviceId(),
        stamp: () => test.identity.hlcStamp(),
      },
    });
    expect(
      (await test.matches.readForWorkout(workoutId(3))).map((row) => [
        row.activityId,
        row.decision,
      ]),
    ).toEqual([[B, "confirmed"]]);
    const read = await test.rides();
    expect(read.rides.find((ride) => ride.activityId === F)?.match).toEqual({ kind: "none" });
  });
  it("rolls the whole answer back and refuses when the workout is taken while it is saved", async () => {
    const test = await harness();
    await test.ride(B, MONDAY + 2, 3_600, { name: "Threshold", load: 60 });
    await test.ride(F, MONDAY + 4, 3_500, { name: "Other ride", load: 50 });
    await test.match(2, B, MONDAY + 2, 3_600, "confirmed");
    test.interleave(async () => {
      await test.match(3, F, MONDAY + 4, 3_500, "confirmed");
    });
    expect(
      await test.decide(B, confirmed(2), { kind: "rematch", planWorkoutId: workoutId(3) }),
    ).toEqual({ status: "refused", reason: "match-changed" });
    expect(
      (await test.matches.readForPlan(PLAN_ID)).map((row) => [
        row.planWorkoutId,
        row.activityId,
        row.decision,
      ]),
    ).toEqual([[workoutId(2), B, "confirmed"]]);
    expect(test.changed).not.toHaveBeenCalled();
  });
  it("reads a zero-length ride, on a day with a Plan Workout of no length or paired in intervals.icu", async () => {
    const test = await harness({
      plan: true,
      extra: [planWorkout(9, MONDAY + 1, null)],
    });
    await test.onIntervals(1, MONDAY, 777);
    await test.ride(A, MONDAY + 1, 0, { name: "Manual entry", load: 0 });
    await test.ride(B, MONDAY, 0, { name: "Paired entry", load: 0, pairedEventId: 777 });
    const read = await test.rides();
    expect(read.rides.map((ride) => [ride.activityId, ride.match])).toEqual([
      [
        A,
        {
          kind: "suggested",
          planWorkoutId: workoutId(9),
          name: "Endurance 9",
          dateKey: MONDAY + 1,
          durationS: null,
        },
      ],
      [
        B,
        expect.objectContaining({
          kind: "confirmed",
          planWorkoutId: workoutId(1),
          by: "intervals",
        }),
      ],
    ]);
    expect((await test.matches.readForPlan(PLAN_ID)).map((row) => row.activityDurationS)).toEqual([
      null,
      null,
    ]);
  });

  it("turns down a ride's suggestion when intervals.icu pairs another ride with that workout", async () => {
    const test = await harness();
    await test.onIntervals(4, MONDAY + 7, 777);
    await test.ride(E, MONDAY + 7, 3_400, { name: "Same-day spin", load: 30 });
    await test.ride(B, MONDAY + 6, 3_600, { name: "Day-early ride", load: 50, pairedEventId: 777 });
    await test.match(4, E, MONDAY + 7, 3_400, "suggested");
    const read = await test.rides();
    expect(read.rides.find((ride) => ride.activityId === E)?.match).toEqual({ kind: "none" });
    expect(read.rides.find((ride) => ride.activityId === B)?.match).toMatchObject({
      kind: "confirmed",
      planWorkoutId: workoutId(4),
      by: "intervals",
    });
    expect(
      (await test.matches.readForWorkout(workoutId(4))).map((row) => [
        row.activityId,
        row.decision,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [E, "rejected"],
        [B, "confirmed"],
      ]),
    );
    expect(await test.calendarOutcome(4)).toBe("moved");
  });

  it("moves a pairing intervals.icu moved to another ride, and frees the old ride", async () => {
    const test = await harness();
    await test.onIntervals(1, MONDAY, 777);
    await test.ride(B, MONDAY, 3_600, { name: "First ride", load: 50 });
    await test.ride(A, MONDAY, 3_500, { name: "Second ride", load: 45, pairedEventId: 777 });
    await test.match(1, B, MONDAY, 3_600, "confirmed", "platform");
    const read = await test.rides();
    expect(read.rides.find((ride) => ride.activityId === A)?.match).toMatchObject({
      kind: "confirmed",
      planWorkoutId: workoutId(1),
      by: "intervals",
    });
    expect(read.rides.find((ride) => ride.activityId === B)?.match).toEqual({ kind: "none" });
    expect(
      (await test.matches.readForWorkout(workoutId(1)))
        .map((row) => [row.activityId, row.source, row.decision])
        .sort(),
    ).toEqual([
      [A, "platform", "confirmed"],
      [B, "platform", "unpaired"],
    ]);
  });

  it("keeps a No on a hand-made match when intervals.icu pairs the ride elsewhere", async () => {
    const test = await harness({ plan: true, extra: [planWorkout(6, MONDAY)] });
    await test.onIntervals(1, MONDAY, 777);
    await test.ride(A, MONDAY, 3_600, { name: "Ride", load: 50, pairedEventId: 777 });
    await test.match(6, A, MONDAY, 3_600, "confirmed");
    expect((await test.rides()).rides[0]?.match).toMatchObject({
      kind: "confirmed",
      planWorkoutId: workoutId(6),
      by: "you",
    });
    expect(await test.decide(A, confirmed(6), { kind: "extra" })).toMatchObject({
      status: "ride",
      ride: { match: { kind: "none" } },
    });
    expect((await test.rides()).rides[0]?.match).toEqual({ kind: "none" });
    expect(
      (await test.matches.readForWorkout(workoutId(1))).map((row) => [row.source, row.decision]),
    ).toEqual([["platform", "unpaired"]]);
    expect(await test.calendarOutcome(1)).toBe("missed");
  });

  it("never suggests or confirms a workout the athlete removed", async () => {
    const test = await harness();
    await test.removed(1, MONDAY);
    await test.ride(A, MONDAY, 3_600, { name: "Ride on a removed day", load: 50 });
    expect((await test.rides()).rides[0]?.match).toEqual({ kind: "none" });
    await test.match(1, A, MONDAY, 3_600, "suggested");
    expect((await test.rides()).rides[0]?.match).toEqual({ kind: "none" });
    expect(
      await test.decide(A, suggested(1), { kind: "confirm", planWorkoutId: workoutId(1) }),
    ).toEqual({ status: "refused", reason: "match-changed" });
    expect(await test.calendarOutcome(1)).toBe("removed-by-you");
  });
});
