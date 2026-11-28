import { describe, expect, it } from "vitest";
import { canonicalJson } from "@enduragent/kernel/archive";
import { PlanCalendarRpcResultSchema } from "@enduragent/coach-contract";
import { encodeIcuCopy } from "@enduragent/engine/calendar";
import {
  createPlanCalendarMirrorRepository,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { workoutContent } from "@enduragent/sport-cycling";
import { landIcuRideSettings } from "../../../apps/desktop/tests/helpers/icu-ftp-fake.js";
import { readPlanCalendar } from "../src/plan-calendar-read.js";

const MONDAY = 19980105;
const TODAY = 19980114;
const PLAN_ID = `${"0".repeat(25)}P`;

async function store() {
  const opened = openSqliteStorage(":memory:");
  await runMigrations(opened, MIGRATIONS);
  return opened;
}

type Store = Awaited<ReturnType<typeof store>>;

async function ride(
  opened: Store,
  key: string,
  dateKey: number,
  payload: { readonly name: string; readonly load: number } | null,
  sport = "cycling",
) {
  const day = String(dateKey);
  const start =
    Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T08:00:00Z`) / 1000;
  await opened.run(
    "INSERT INTO workout (workout_key, start_utc, tz_offset_s, name, dedup_cluster_id) VALUES (?, ?, 0, NULL, ?)",
    [key, start, key],
  );
  await opened.run(
    `INSERT INTO session (session_key, workout_key, session_seq, sport, start_utc, tz_offset_s,
      local_date_key, moving_s, distance_m, is_transition)
     VALUES (?, ?, 0, ?, ?, 0, ?, 3900, 32000, 0)`,
    [key, key, sport, start, dateKey],
  );
  if (payload === null) return;
  const artifact = `${key.slice(0, 63)}f`;
  await opened.run(
    "INSERT INTO source_artifact(artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s) VALUES(?,?,?,?,?,?,?,?)",
    [
      artifact,
      "intervals-icu",
      "activities",
      `i${key.slice(0, 6)}${dateKey}`,
      "snapshot",
      "d".repeat(64),
      `1998/${artifact}.json.gz`,
      start,
    ],
  );
  await opened.run(
    "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json,artifact_key) VALUES(?,?,?,?,?,?,?,?,?)",
    [
      `${key.slice(0, 63)}e`,
      key,
      key,
      "intervals-icu",
      `i${key.slice(0, 6)}${dateKey}`,
      "c".repeat(64),
      1,
      canonicalJson({
        activity: {
          id: `i${key.slice(0, 6)}${dateKey}`,
          name: payload.name,
          icu_training_load: payload.load,
          start_date_local: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T08:00:00`,
          type: "Ride",
        },
        concerns: {},
        dedup: {},
        schema_version: 1,
      }),
      artifact,
    ],
  );
}

function deps(opened: Store) {
  return {
    store: opened,
    todayDateKey: TODAY,
    calendarConnected: true,
    dateKeyOfMs: () => TODAY,
    athleteId: "i1998",
  };
}

async function activePlan(opened: Store, workouts: readonly PlanWorkoutRecord[]) {
  await createPlanRepository(opened).replace(
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
    [...workouts],
  );
  await opened.run(
    `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
     VALUES (?,'active',1,1,1,1,'test-device',1,0)`,
    [PLAN_ID],
  );
}

function planWorkout(index: number, dateKey: number): PlanWorkoutRecord {
  return {
    id: `${"0".repeat(24)}${String(10 + index)}`,
    planId: PLAN_ID,
    dateKey,
    sport: "Ride",
    name: `Endurance ${index}`,
    durationS: 3_600,
    structureJson: "{}",
    origin: "coach",
    deviceId: "test-device",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
  };
}

describe("the calendar read", () => {
  it("names each synced ride from intervals.icu and reads its Load, without a Plan", async () => {
    const opened = await store();
    await ride(opened, "a".repeat(64), TODAY - 2, { name: "Synthetic tempo", load: 55 });
    await ride(opened, "b".repeat(64), 19980301, { name: "Later ride", load: 40 });
    await ride(opened, "c".repeat(64), TODAY, null, "running");
    await ride(opened, "d".repeat(64), TODAY - 1, { name: "   ", load: 20 });
    const read = PlanCalendarRpcResultSchema.parse(
      await readPlanCalendar(deps(opened), { startDateKey: 19980105, endDateKey: 19980201 }),
    );
    expect(read).toEqual({
      status: "calendar",
      todayDateKey: TODAY,
      calendarConnected: true,
      weekDelivery: "send-each-week",
      plan: null,
      replacing: null,
      ftp: null,
      activities: [
        {
          activityId: "a".repeat(64),
          dateKey: TODAY - 2,
          name: "Synthetic tempo",
          sport: "cycling",
          durationS: 3900,
          distanceM: 32000,
          load: 55,
          workoutId: null,
        },
        {
          activityId: "d".repeat(64),
          dateKey: TODAY - 1,
          name: null,
          sport: "cycling",
          durationS: 3900,
          distanceM: 32000,
          load: 20,
          workoutId: null,
        },
      ],
    });
    await opened.close();
  });

  it("returns no rides for a range with an impossible date instead of failing", async () => {
    const opened = await store();
    const read = await readPlanCalendar(deps(opened), {
      startDateKey: 19981399,
      endDateKey: 19981420,
    });
    expect(read.activities).toEqual([]);
    await opened.close();
  });

  it("counts done time once per workout and leaves kept and removed workouts out of the totals", async () => {
    const opened = await store();
    const workouts = [
      planWorkout(1, MONDAY),
      planWorkout(2, MONDAY + 1),
      planWorkout(3, MONDAY + 2),
      planWorkout(4, MONDAY + 3),
    ];
    await createPlanRepository(opened).replace(
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
    await opened.run(
      `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
       VALUES (?,'active',1,1,1,1,'test-device',1,0)`,
      [PLAN_ID],
    );
    const matches = createPlanWorkoutMatchRepository(opened);
    const confirm = async (
      index: number,
      activity: string,
      dateKey: number,
      seconds: number,
      decision: "confirmed" | "suggested",
    ) => {
      await ride(opened, activity, dateKey, { name: `Ride ${index}`, load: 30 });
      await matches.observe({
        id: `${"0".repeat(24)}M${index}`,
        planId: PLAN_ID,
        planWorkoutId: workouts[index - 1]?.id ?? "",
        activityId: activity,
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
    await confirm(1, "a".repeat(64), MONDAY, 3_700, "confirmed");
    await confirm(2, "b".repeat(64), MONDAY + 2, 2_400, "confirmed");
    await confirm(3, "c".repeat(64), MONDAY + 2, 3_000, "suggested");
    await confirm(4, "e".repeat(64), MONDAY + 3, 1_200, "confirmed");
    await createPlanCalendarMirrorRepository(opened).writeCopy({
      planId: PLAN_ID,
      planWorkoutId: workouts[3]?.id ?? "",
      dateKey: MONDAY + 3,
      stateKind: "kept-as-yours",
      stateJson: encodeIcuCopy({ kind: "kept-as-yours", eventId: 9 }),
      lastWrite: { kind: "none" },
      updatedAtMs: 1,
    });
    const read = PlanCalendarRpcResultSchema.parse(
      await readPlanCalendar(deps(opened), { startDateKey: MONDAY, endDateKey: 19980118 }),
    );
    if (read.status !== "calendar" || read.plan === null) throw new Error("Expected a Plan");
    expect(read.plan.workouts.map((workout) => [workout.outcome.kind, workout.doneS])).toEqual([
      ["done-as-planned", 3_700],
      ["moved", 2_400],
      ["is-this-it", 0],
      ["done-differently", 1_200],
    ]);
    expect(read.plan.weeks[0]).toMatchObject({
      index: 1,
      plannedS: 10_800,
      doneS: 6_100,
      toConfirm: 1,
    });
    expect(read.activities.find((entry) => entry.activityId === "a".repeat(64))).toMatchObject({
      name: "Ride 1",
      workoutId: workouts[0]?.id,
    });
    await opened.close();
  });

  it("carries each Chat Plan workout's content and the one FTP, and none for older rows", async () => {
    const opened = await store();
    const content = workoutContent("hard", 45);
    const structure = (value: unknown) => canonicalJson({ id: "w1-template-1", content: value });
    await activePlan(opened, [
      { ...planWorkout(1, MONDAY), durationS: 2_700, structureJson: structure(content) },
      planWorkout(2, MONDAY + 1),
      { ...planWorkout(3, MONDAY + 2), structureJson: structure({ version: 2, steps: [] }) },
      { ...planWorkout(4, MONDAY + 3), structureJson: '"not an object"' },
    ]);
    const range = { startDateKey: MONDAY, endDateKey: 19980118 };
    const before = PlanCalendarRpcResultSchema.parse(await readPlanCalendar(deps(opened), range));
    if (before.status !== "calendar" || before.plan === null) throw new Error("Expected a Plan");
    expect(before.ftp).toBeNull();
    expect(before.plan.workouts.map((workout) => workout.content)).toEqual([
      content,
      undefined,
      undefined,
      undefined,
    ]);
    expect(before.plan.workouts[1]).not.toHaveProperty("content");
    await landIcuRideSettings(opened, {
      id: 77,
      ftp: 210,
      indoorFtp: 200,
      updated: "1998-01-02T08:00:00.000+00:00",
    });
    const civil = (ms: number) =>
      Number(new Date(ms).toISOString().slice(0, 10).replaceAll("-", ""));
    const after = PlanCalendarRpcResultSchema.parse(
      await readPlanCalendar({ ...deps(opened), dateKeyOfMs: civil }, range),
    );
    expect(after.status === "calendar" && after.ftp).toEqual({ watts: 210, dateKey: 19980102 });
    await opened.close();
  });
});
