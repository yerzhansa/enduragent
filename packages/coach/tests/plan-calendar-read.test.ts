import { describe, expect, it } from "vitest";
import { PlanCalendarRpcResultSchema } from "@enduragent/coach-contract";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { readPlanCalendar } from "../src/plan-calendar-read.js";

const TODAY = 19980114;

async function store() {
  const opened = openSqliteStorage(":memory:");
  await runMigrations(opened, MIGRATIONS);
  return opened;
}

async function ride(
  opened: Awaited<ReturnType<typeof store>>,
  key: string,
  dateKey: number,
  name: string | null,
) {
  await opened.run(
    "INSERT INTO workout (workout_key, start_utc, tz_offset_s, name, dedup_cluster_id) VALUES (?, 884764800, 0, ?, ?)",
    [key, name, key],
  );
  await opened.run(
    `INSERT INTO session (session_key, workout_key, session_seq, sport, start_utc, tz_offset_s,
      local_date_key, moving_s, distance_m, is_transition)
     VALUES (?, ?, 0, 'Ride', 884764800, 0, ?, 3900, 32000, 0)`,
    [key, key, dateKey],
  );
}

describe("the calendar read", () => {
  it("lists the athlete's Activities in the range when there is no Plan", async () => {
    const opened = await store();
    await ride(opened, "a".repeat(64), TODAY - 2, "Road ride");
    await ride(opened, "b".repeat(64), 19980301, "Later ride");
    const read = await readPlanCalendar(
      { store: opened, todayDateKey: TODAY, calendarConnected: true, dateKeyOfMs: () => TODAY },
      { startDateKey: 19980105, endDateKey: 19980201 },
    );
    expect(PlanCalendarRpcResultSchema.parse(read)).toEqual({
      status: "calendar",
      todayDateKey: TODAY,
      calendarConnected: true,
      weekDelivery: "send-each-week",
      plan: null,
      activities: [
        {
          activityId: "a".repeat(64),
          dateKey: TODAY - 2,
          name: "Road ride",
          sport: "Ride",
          durationS: 3900,
          distanceM: 32000,
          load: null,
          workoutId: null,
        },
      ],
    });
    await opened.close();
  });
});
