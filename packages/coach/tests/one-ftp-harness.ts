import { onTestFinished } from "vitest";
import {
  PlanCalendarRpcResultSchema,
  type PlanCalendarFtpRead,
  type PlanCalendarRpcParams,
  type PlanCalendarRpcResult,
} from "@enduragent/coach-contract";
import type { FtpTestResult } from "@enduragent/engine/calendar";
import { addCivilDays } from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createFakeIcuSportSettings,
  landIcuEstimate,
  landIcuRideSettings,
  type IcuRideSettingsFixture,
} from "../../../apps/desktop/tests/helpers/icu-ftp-fake.js";
import { createMemoryPlanCalendar } from "../../../apps/desktop/tests/helpers/plan-calendar-fake.js";
import { checkFtp } from "../src/one-ftp.js";
import { createPlanCalendarOperations } from "../src/plan-calendar-operations.js";

export const ATHLETE = "i1998";
export const SET_DAY = 19980713;
export const SET_AT = "1998-07-13T08:12:34.567+00:00";
export const RIDE: IcuRideSettingsFixture = { id: 77, ftp: 282, indoorFtp: null, updated: SET_AT };

export function dateKeyOf(ms: number): number {
  return Number(new Date(ms).toISOString().slice(0, 10).replaceAll("-", ""));
}

export function msOf(dateKey: number, time = "12:00:00.000"): number {
  const text = String(dateKey);
  return Date.parse(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${time}Z`);
}

export async function seedRide(
  store: SqlStore,
  ride: {
    readonly key: string;
    readonly startMs: number;
    readonly icuFtp?: number;
    readonly subSport?: string;
  },
): Promise<void> {
  const start = Math.floor(ride.startMs / 1_000);
  const dateKey = dateKeyOf(ride.startMs);
  await store.run(
    "INSERT INTO workout (workout_key, start_utc, tz_offset_s, name, dedup_cluster_id) VALUES (?, ?, 0, NULL, ?)",
    [ride.key, start, ride.key],
  );
  await store.run(
    `INSERT INTO session (session_key, workout_key, session_seq, sport, sub_sport, start_utc, tz_offset_s,
      local_date_key, moving_s, distance_m, is_transition, summary_json)
     VALUES (?, ?, 0, 'cycling', ?, ?, 0, ?, 3600, 30000, 0, ?)`,
    [
      ride.key,
      ride.key,
      ride.subSport ?? null,
      start,
      dateKey,
      JSON.stringify(
        ride.icuFtp === undefined ? { type: "Ride" } : { type: "Ride", icu_ftp: ride.icuFtp },
      ),
    ],
  );
}

export interface FtpHarness {
  readonly store: SqlStore & MigratorStore;
  readonly icu: ReturnType<typeof createFakeIcuSportSettings>;
  call(request: PlanCalendarRpcParams): Promise<PlanCalendarRpcResult>;
  read(): Promise<PlanCalendarFtpRead>;
  sync(): Promise<void>;
  answer(
    answer: "keep" | "use" | "confirm" | "cancel",
    expected: { kind: "shown" | "confirming"; watts: number },
  ): Promise<PlanCalendarFtpRead>;
  land(settings: IcuRideSettingsFixture): Promise<void>;
  setToday(dateKey: number): void;
  setNow(ms: number): void;
  setTests(next: readonly FtpTestFixture[]): void;
  setAthlete(athleteId: string | null): void;
  estimates(days: number, watts: number, through?: number): Promise<void>;
}

export interface FtpTestFixture {
  readonly activityId: string;
  readonly dateKey: number;
  readonly startMs?: number;
  readonly twentyMinuteWatts: number;
}

export async function ftpHarness(
  initial: IcuRideSettingsFixture | null = RIDE,
  options: { readonly athleteId?: string | null } = {},
): Promise<FtpHarness> {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  onTestFinished(async () => {
    await store.close();
  });
  let today = 19980819;
  let nowMs: number | null = null;
  let sequence = 100;
  let tests: FtpTestResult[] = [];
  const clock = () => nowMs ?? msOf(today);
  const icu = createFakeIcuSportSettings(initial ?? { ...RIDE, ftp: null }, clock);
  if (initial !== null) await landIcuRideSettings(store, initial);
  let athlete = options.athleteId === undefined ? ATHLETE : options.athleteId;
  const athleteId = () => athlete;
  const testSource = { read: async () => tests };
  const operations = createPlanCalendarOperations({
    store,
    calendar: createMemoryPlanCalendar(),
    identity: {
      deviceId: async () => "ftp-test-device",
      newUlid: () => String(++sequence).padStart(26, "0"),
      hlcStamp: () => ({ physicalMs: clock(), counter: ++sequence }),
    },
    applyChange: async () => ({ status: "rejected", reason: "stale-version" }) as never,
    todayDateKey: () => today,
    now: clock,
    calendarConnected: () => true,
    dateKeyOfMs: dateKeyOf,
    changed: async () => undefined,
    ftp: { icu: icu.port, tests: testSource, athleteId },
  });
  const call = async (request: PlanCalendarRpcParams) =>
    PlanCalendarRpcResultSchema.parse(await operations["plan.calendar"](request));
  const ftp = async (request: PlanCalendarRpcParams): Promise<PlanCalendarFtpRead> => {
    const result = await call(request);
    if (result.status !== "ftp") throw new TypeError(`unexpected ${result.status}`);
    return result;
  };
  return {
    store,
    icu,
    call,
    read: () => ftp({ action: "ftp" }),
    sync: () =>
      checkFtp({
        store,
        icu: icu.port,
        tests: testSource,
        todayDateKey: () => today,
        now: clock,
        dateKeyOfMs: dateKeyOf,
        newId: () => String(++sequence).padStart(26, "0"),
        athleteId,
      }),
    answer: (answer, expected) => ftp({ action: "ftp-answer", answer, expected }),
    land: (settings) => landIcuRideSettings(store, settings),
    setToday(dateKey) {
      today = dateKey;
    },
    setNow(ms) {
      nowMs = ms;
    },
    setTests(next) {
      tests = next.map((test) => ({ ...test, startMs: test.startMs ?? msOf(test.dateKey) }));
    },
    setAthlete(next) {
      athlete = next;
    },
    async estimates(days, watts, through = today) {
      for (let offset = 0; offset < days; offset += 1) {
        await landIcuEstimate(store, addCivilDays(through, -offset), watts);
      }
    },
  };
}
