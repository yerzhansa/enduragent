import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { WellnessDay } from "@enduragent/kernel/reference/schemas";
import type {
  CanonicalActivityDetail,
  CanonicalActivityReader,
  CanonicalActivitySummary,
} from "@enduragent/kernel/store";

export type DataSetting = "connected" | "not-connected" | "reads-failing" | "implausible-ftp";

const FTP_WATTS = 268;
export const IMPLAUSIBLE_FTP_WATTS = 720;
export const RECENT_RIDE_ID = "90401";
const SYNC_AGE_MS = 12 * 60_000;

interface ActivitySeed {
  readonly id: string;
  readonly dayOffset: number;
  readonly startTime: string;
  readonly subSport: "road" | "indoor_cycling";
  readonly movingSeconds: number;
  readonly pausedSeconds: number;
  readonly distanceMeters: number;
  readonly watts: number;
  readonly heartRate: number;
}

const ACTIVITY_SEEDS: readonly ActivitySeed[] = [
  { id: "90401", dayOffset: -1, startTime: "07:10:00", subSport: "road", movingSeconds: 7_260, pausedSeconds: 420, distanceMeters: 61_400, watts: 201, heartRate: 146 },
  { id: "90402", dayOffset: -3, startTime: "18:05:00", subSport: "indoor_cycling", movingSeconds: 2_700, pausedSeconds: 0, distanceMeters: 21_300, watts: 142, heartRate: 118 },
  { id: "90403", dayOffset: -4, startTime: "06:45:00", subSport: "indoor_cycling", movingSeconds: 4_020, pausedSeconds: 0, distanceMeters: 33_800, watts: 224, heartRate: 152 },
  { id: "90404", dayOffset: -6, startTime: "08:30:00", subSport: "road", movingSeconds: 9_480, pausedSeconds: 660, distanceMeters: 74_900, watts: 183, heartRate: 139 },
  { id: "90405", dayOffset: -11, startTime: "09:00:00", subSport: "road", movingSeconds: 12_600, pausedSeconds: 900, distanceMeters: 98_200, watts: 176, heartRate: 136 },
  { id: "90406", dayOffset: -13, startTime: "06:50:00", subSport: "indoor_cycling", movingSeconds: 4_500, pausedSeconds: 0, distanceMeters: 37_100, watts: 216, heartRate: 149 },
];

export function dateKey(today: Date, dayOffset: number): string {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + dayOffset);
  return day.toISOString().slice(0, 10);
}

const WELLNESS_DAYS = 14;
const fitnessOn = (index: number): number => 52 + Math.round(index * 0.7);
const fatigueOn = (index: number): number => 55 + ((index * 5) % 13);

function wellnessDay(today: Date, index: number): WellnessDay {
  return {
    id: dateKey(today, index - (WELLNESS_DAYS - 1)),
    fitness: fitnessOn(index),
    fatigue: fatigueOn(index),
    restingHR: 48 + (index % 3),
    hrv: 64 + ((index * 7) % 11),
    sleepSecs: 25_200 + ((index * 1_800) % 5_400),
    weight: null,
    sleepQuality: null,
  };
}

export interface LatestWellness {
  readonly fitness: number;
  readonly fatigue: number;
  readonly form: number;
}

export function latestWellness(): LatestWellness {
  const fitness = fitnessOn(WELLNESS_DAYS - 1);
  const fatigue = fatigueOn(WELLNESS_DAYS - 1);
  return { fitness, fatigue, form: fitness - fatigue };
}

function summary(seed: ActivitySeed, today: Date): CanonicalActivitySummary {
  const localDate = dateKey(today, seed.dayOffset);
  return {
    id: seed.id,
    workoutId: `w${seed.id}`,
    sessionSequence: 1,
    isMultisport: false,
    sport: "cycling",
    subSport: seed.subSport,
    isTransition: false,
    startEpochSeconds: Date.parse(`${localDate}T${seed.startTime}Z`) / 1_000,
    timezoneOffsetSeconds: 0,
    localDate,
    elapsedSeconds: seed.movingSeconds + seed.pausedSeconds,
    timerSeconds: seed.movingSeconds,
    movingSeconds: seed.movingSeconds,
    distanceMeters: seed.distanceMeters,
  };
}

function detail(seed: ActivitySeed, today: Date): CanonicalActivityDetail {
  const base = summary(seed, today);
  const count = Math.max(1, Math.round(seed.movingSeconds / 1_800));
  const lapSeconds = Math.round(seed.movingSeconds / count);
  return {
    ...base,
    laps: Array.from({ length: count }, (_, index) => ({
      lapSequence: index + 1,
      startEpochSeconds: base.startEpochSeconds + index * lapSeconds,
      elapsedSeconds: lapSeconds,
      timerSeconds: lapSeconds,
      distanceMeters: Math.round(seed.distanceMeters / count),
    })),
  };
}

function channels(seed: ActivitySeed): Record<string, readonly number[]> {
  const samples = 240;
  const step = Math.round(seed.movingSeconds / samples);
  const wave = (index: number, period: number, amplitude: number): number =>
    Math.round(Math.sin((index / period) * Math.PI * 2) * amplitude);
  return {
    time: Array.from({ length: samples }, (_, index) => index * step),
    power: Array.from({ length: samples }, (_, index) => seed.watts + wave(index, 37, 48)),
    heart_rate: Array.from({ length: samples }, (_, index) => seed.heartRate + wave(index, 53, 11)),
    cadence: Array.from({ length: samples }, (_, index) => 88 + wave(index, 29, 6)),
    altitude: Array.from({ length: samples }, (_, index) => 210 + wave(index, 120, 85)),
  };
}

export interface StoreFixture {
  readonly snapshot: ProducedLocalBundle;
  readonly activities: CanonicalActivityReader;
}

export function buildStoreFixture(setting: "connected" | "implausible-ftp", today: Date): StoreFixture {
  const ftp = setting === "implausible-ftp" ? IMPLAUSIBLE_FTP_WATTS : FTP_WATTS;
  const captureEpochMs = today.getTime() - SYNC_AGE_MS;
  const find = (id: string) => ACTIVITY_SEEDS.find((seed) => seed.id === id);
  return {
    snapshot: {
      captureId: "coach-eval",
      captureClock: {
        captureEpochMs,
        civilDateTime: new Date(captureEpochMs).toISOString().slice(0, 19),
        calendarTimeZone: "UTC",
      },
      bundle: {
        activities: [],
        wellness: Array.from({ length: WELLNESS_DAYS }, (_, index) => wellnessDay(today, index)),
        ftpHistory: [],
        athlete: {
          icuFtp: ftp,
          icuWeight: 64,
          icuMaxHr: 186,
          icuLthr: 166,
          icuRestingHr: 48,
          sportSettings: [{ types: ["Ride", "VirtualRide"], ftp, lthr: 166 }],
        },
      },
    },
    activities: {
      listActivities: async ({ start, end }) => ({
        activities: ACTIVITY_SEEDS.map((seed) => summary(seed, today))
          .filter((activity) => activity.localDate >= start && activity.localDate <= end)
          .sort((a, b) => b.startEpochSeconds - a.startEpochSeconds),
        nextCursor: null,
      }),
      getActivity: async ({ id }) => {
        const seed = find(id);
        return seed === undefined ? undefined : detail(seed, today);
      },
      getStreams: async ({ id, channels: requested }) => {
        const seed = find(id);
        if (seed === undefined) return undefined;
        const all = channels(seed);
        return {
          activityId: id,
          channels: Object.fromEntries(Object.entries(all).filter(([name]) => requested.includes(name))),
        };
      },
    },
  };
}
