import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../../src/sqlite/index.js";

export async function legacyV11Store(dir: string) {
  await mkdir(dir, { recursive: true });
  const store = openSqliteStorage(join(dir, "store.db"));
  try {
    await runMigrations(store, MIGRATIONS.slice(0, 11));
    const stamp = ["synthetic-device", Date.UTC(1998, 6, 6, 12), 0];
    await store.run(
      `INSERT INTO athlete (id, display_name, timezone, units, device_id, hlc_physical_ms, hlc_counter)
       VALUES (?, 'Synthetic Athlete', 'UTC', 'metric', ?, ?, ?)`,
      ["00000000000000000000000011", ...stamp],
    );
    await store.run(
      `INSERT INTO sport_settings (id, sport, preferred_units, device_id, hlc_physical_ms, hlc_counter)
       VALUES (?, 'cycling', 'metric', ?, ?, ?)`,
      ["00000000000000000000000012", ...stamp],
    );
    await store.run(
      `INSERT INTO planned_workout (id, date_key, sport, structure_json, status, provenance,
       device_id, hlc_physical_ms, hlc_counter)
       VALUES (?, 19980707, 'cycling', ?, 'planned', 'manual', ?, ?, ?)`,
      [
        "00000000000000000000000013",
        JSON.stringify({ name: "Easy ride", durationS: 1800 }),
        ...stamp,
      ],
    );
    await store.run(
      `INSERT INTO race_goal (id, date_key, sport, name, priority, device_id, hlc_physical_ms, hlc_counter)
       VALUES (?, 19980830, 'cycling', 'Synthetic Fondo', 'A', ?, ?, ?)`,
      ["00000000000000000000000014", ...stamp],
    );
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

export function legacyCurrentPlanJson(variant: "draft" | "active" | "with-workouts") {
  const workouts = [
    {
      dateKey: 19980708,
      date: "1998-07-07",
      sport: "cycling",
      name: "Easy ride",
      durationS: 1800,
      totalDuration: 2400,
      origin: "athlete",
    },
    {
      dateKey: null,
      date: "1998-07-09",
      sport: "running",
      name: "Endurance run",
      durationS: null,
      totalDuration: 3600,
      origin: "coach",
    },
  ];
  return {
    id: "32cc7944-facd-4b56-b1a1-7dfe43e4bfe7",
    name: "8-Week Plan",
    primaryGoal: "Gran Fondo",
    targetDate: "1998-08-30T00:00:00.000Z",
    totalWeeks: 8,
    phases: [],
    startDate: "1998-07-06",
    createdAt: "1998-07-04T12:00:00.000Z",
    updatedAt: "1998-07-05T10:00:00.000Z",
    status: variant === "active" ? "active" : "draft",
    workouts: variant === "with-workouts" ? workouts : [],
  };
}

export async function dumpLegacyV11Tables(store: SqlStore) {
  return {
    athlete: await store.all("SELECT * FROM athlete ORDER BY rowid"),
    sport_settings: await store.all("SELECT * FROM sport_settings ORDER BY rowid"),
    planned_workout: await store.all("SELECT * FROM planned_workout ORDER BY rowid"),
    race_goal: await store.all("SELECT * FROM race_goal ORDER BY rowid"),
  };
}
