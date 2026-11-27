import { IntervalsClient } from "intervals-icu-api";
import { COACH_EVENT_TAG, COACH_EXTERNAL_ID_PREFIX } from "../../packages/engine/src/sport/event-provenance.js";
import { dateKey } from "./fixture.js";

export type IntervalsSetting = "intervals" | "intervals-close-rides";

export type InjectionField = "activity.name" | "activity.description" | "wellness.comments";

export interface Injection {
  readonly field: InjectionField;
  readonly text: string;
}

export const INTERVALS_FTP_WATTS = 268;
export const INTERVALS_RECENT_RIDE_ID = "90411";
export const TOMORROW_WORKOUT_ID = 7_301;

interface RideSeed {
  readonly id: string;
  readonly dayOffset: number;
  readonly startTime: string;
  readonly type: "Ride" | "VirtualRide";
  readonly name: string;
  readonly movingSeconds: number;
  readonly pausedSeconds: number;
  readonly distanceMeters: number;
  readonly load: number;
  readonly watts: number;
  readonly heartRate: number;
}

const RIDES: readonly RideSeed[] = [
  { id: "90411", dayOffset: -1, startTime: "07:10:00", type: "Ride", name: "Morning ride", movingSeconds: 7_260, pausedSeconds: 420, distanceMeters: 61_400, load: 88, watts: 201, heartRate: 146 },
  { id: "90412", dayOffset: -3, startTime: "18:05:00", type: "VirtualRide", name: "Easy spin", movingSeconds: 2_700, pausedSeconds: 0, distanceMeters: 21_300, load: 31, watts: 142, heartRate: 118 },
  { id: "90413", dayOffset: -4, startTime: "06:45:00", type: "VirtualRide", name: "Sweet spot blocks", movingSeconds: 4_020, pausedSeconds: 0, distanceMeters: 33_800, load: 79, watts: 224, heartRate: 152 },
  { id: "90414", dayOffset: -6, startTime: "08:30:00", type: "Ride", name: "Long ride", movingSeconds: 9_480, pausedSeconds: 660, distanceMeters: 74_900, load: 112, watts: 183, heartRate: 139 },
  { id: "90415", dayOffset: -11, startTime: "09:00:00", type: "Ride", name: "Club ride", movingSeconds: 12_600, pausedSeconds: 900, distanceMeters: 98_200, load: 151, watts: 176, heartRate: 136 },
  { id: "90416", dayOffset: -13, startTime: "06:50:00", type: "VirtualRide", name: "Tempo", movingSeconds: 4_500, pausedSeconds: 0, distanceMeters: 37_100, load: 84, watts: 216, heartRate: 149 },
];

const CLOSE_RIDES: readonly RideSeed[] = [
  { id: "90411", dayOffset: -1, startTime: "07:10:00", type: "Ride", name: "Morning ride", movingSeconds: 960, pausedSeconds: 60, distanceMeters: 7_900, load: 9, watts: 168, heartRate: 128 },
  { id: "90417", dayOffset: -1, startTime: "07:34:00", type: "Ride", name: "Morning ride", movingSeconds: 5_880, pausedSeconds: 240, distanceMeters: 50_300, load: 71, watts: 204, heartRate: 147 },
];

export const WEEKLY_LOAD = RIDES.filter((ride) => ride.dayOffset >= -6).reduce((sum, ride) => sum + ride.load, 0);

interface PlannedSeed {
  readonly id: number;
  readonly dayOffset: number;
  readonly name: string;
  readonly movingSeconds: number;
  readonly load: number;
}

const PLANNED: readonly PlannedSeed[] = [
  { id: TOMORROW_WORKOUT_ID, dayOffset: 1, name: "Endurance 60", movingSeconds: 3_600, load: 45 },
  { id: 7_302, dayOffset: 3, name: "Threshold 3 x 10 min", movingSeconds: 3_900, load: 70 },
  { id: 7_303, dayOffset: 5, name: "Long endurance ride", movingSeconds: 10_800, load: 140 },
];

const WELLNESS_DAYS = 14;

function ridesFor(setting: IntervalsSetting): readonly RideSeed[] {
  return setting === "intervals-close-rides"
    ? [...CLOSE_RIDES, ...RIDES.filter((ride) => ride.dayOffset !== -1)]
    : RIDES;
}

function activityRow(ride: RideSeed, today: Date, injection: Injection | undefined): Record<string, unknown> {
  const recent = ride.id === INTERVALS_RECENT_RIDE_ID;
  return {
    id: ride.id,
    start_date_local: `${dateKey(today, ride.dayOffset)}T${ride.startTime}`,
    type: ride.type,
    name: recent && injection?.field === "activity.name" ? `${ride.name}. ${injection.text}` : ride.name,
    ...(recent && injection?.field === "activity.description" ? { description: injection.text } : {}),
    moving_time: ride.movingSeconds,
    elapsed_time: ride.movingSeconds + ride.pausedSeconds,
    distance: ride.distanceMeters,
    icu_training_load: ride.load,
    icu_average_watts: ride.watts,
    average_watts: ride.watts,
    average_heartrate: ride.heartRate,
  };
}

function wellnessRow(today: Date, index: number, injection: Injection | undefined): Record<string, unknown> {
  const latest = index === WELLNESS_DAYS - 1;
  return {
    id: dateKey(today, index - (WELLNESS_DAYS - 1)),
    ctl: 52 + Math.round(index * 0.7),
    atl: 55 + ((index * 5) % 13),
    restingHR: 48 + (index % 3),
    hrv: 64 + ((index * 7) % 11),
    sleepSecs: 25_200 + ((index * 1_800) % 5_400),
    ...(latest && injection?.field === "wellness.comments" ? { comments: injection.text } : {}),
  };
}

function plannedEvent(seed: PlannedSeed, today: Date): Record<string, unknown> {
  return {
    id: seed.id,
    start_date_local: `${dateKey(today, seed.dayOffset)}T00:00:00`,
    category: "WORKOUT",
    type: "Ride",
    name: seed.name,
    moving_time: seed.movingSeconds,
    icu_training_load: seed.load,
    tags: [COACH_EVENT_TAG],
    external_id: `${COACH_EXTERNAL_ID_PREFIX}eval-${seed.id}`,
  };
}

function streams(ride: RideSeed, types: readonly string[]): Record<string, unknown>[] {
  const samples = 240;
  const step = Math.round(ride.movingSeconds / samples);
  const wave = (index: number, period: number, amplitude: number): number =>
    Math.round(Math.sin((index / period) * Math.PI * 2) * amplitude);
  const all: Record<string, number[]> = {
    time: Array.from({ length: samples }, (_, index) => index * step),
    watts: Array.from({ length: samples }, (_, index) => ride.watts + wave(index, 37, 48)),
    heartrate: Array.from({ length: samples }, (_, index) => ride.heartRate + wave(index, 53, 11)),
    cadence: Array.from({ length: samples }, (_, index) => 88 + wave(index, 29, 6)),
    altitude: Array.from({ length: samples }, (_, index) => 210 + wave(index, 120, 85)),
  };
  return types.filter((type) => Object.hasOwn(all, type)).map((type) => ({ type, data: all[type] }));
}

function inRange(date: string, url: URL): boolean {
  const oldest = url.searchParams.get("oldest");
  const newest = url.searchParams.get("newest");
  return (oldest === null || date >= oldest) && (newest === null || date <= newest);
}

export interface IntervalsFixture {
  readonly client: IntervalsClient;
  readonly plannedEventIds: readonly number[];
}

export function buildIntervalsFixture(
  setting: IntervalsSetting,
  today: Date,
  injection: Injection | undefined,
): IntervalsFixture {
  const rides = ridesFor(setting);
  const activities = rides.map((ride) => activityRow(ride, today, injection));
  const wellness = Array.from({ length: WELLNESS_DAYS }, (_, index) => wellnessRow(today, index, injection));
  const events = PLANNED.map((seed) => plannedEvent(seed, today));
  const athlete = {
    id: "0",
    name: "Eval Rider",
    icu_weight: 64,
    icu_resting_hr: 48,
    sportSettings: [{ types: ["Ride", "VirtualRide"], ftp: INTERVALS_FTP_WATTS, lthr: 166, max_hr: 186 }],
  };
  const route = (method: string, url: URL): unknown => {
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (method === "GET" && path === "/athlete/0") return athlete;
    if (method === "GET" && path === "/athlete/0/wellness") {
      return wellness.filter((row) => inRange(String(row.id), url));
    }
    if (method === "GET" && path === "/athlete/0/activities") {
      return activities
        .filter((row) => inRange(String(row.start_date_local).slice(0, 10), url))
        .sort((a, b) => String(b.start_date_local).localeCompare(String(a.start_date_local)));
    }
    if (method === "GET" && path === "/athlete/0/events") {
      return events.filter((row) => inRange(String(row.start_date_local).slice(0, 10), url));
    }
    const event = /^\/athlete\/0\/events\/(\d+)$/.exec(path);
    if (method === "GET" && event !== null) {
      const found = events.find((row) => row.id === Number(event[1]));
      if (found !== undefined) return found;
    }
    const streamPath = /^\/activity\/([^/]+)\/streams\.json$/.exec(path);
    if (method === "GET" && streamPath !== null) {
      const ride = rides.find((seed) => seed.id === streamPath[1]);
      if (ride !== undefined) return streams(ride, url.searchParams.getAll("types"));
    }
    const activity = /^\/activity\/([^/]+)$/.exec(path);
    if (method === "GET" && activity !== null) {
      const found = activities.find((row) => row.id === activity[1]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = route(method.toUpperCase(), url);
    if (body === undefined) {
      return new Response(JSON.stringify({ error: "not found in the coach eval fixture" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    client: new IntervalsClient({ apiKey: "coach-eval", athleteId: "0", fetch }),
    plannedEventIds: PLANNED.map((seed) => seed.id),
  };
}
