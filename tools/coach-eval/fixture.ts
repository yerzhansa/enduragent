export type DataSetting = "connected" | "not-connected" | "reads-failing" | "implausible-ftp";

export const FIXTURE_FTP_WATTS = 268;
export const IMPLAUSIBLE_FTP_WATTS = 720;

interface ActivitySeed {
  readonly id: number;
  readonly dayOffset: number;
  readonly startTime: string;
  readonly type: "Ride" | "VirtualRide";
  readonly name: string;
  readonly movingTime: number;
  readonly distance: number;
  readonly icuTrainingLoad: number;
  readonly averageWatts: number;
  readonly averageHeartrate: number;
  readonly maxHeartrate: number;
  readonly totalElevationGain: number;
}

interface WellnessSeed {
  readonly dayOffset: number;
  readonly fitness: number;
  readonly fatigue: number;
  readonly restingHR: number;
  readonly hrv: number;
  readonly sleepSecs: number;
}

const ACTIVITY_SEEDS: readonly ActivitySeed[] = [
  {
    id: 90401,
    dayOffset: -1,
    startTime: "07:10:00",
    type: "Ride",
    name: "Valley loop with tempo finish",
    movingTime: 7_260,
    distance: 61_400,
    icuTrainingLoad: 96,
    averageWatts: 201,
    averageHeartrate: 146,
    maxHeartrate: 171,
    totalElevationGain: 540,
  },
  {
    id: 90402,
    dayOffset: -3,
    startTime: "18:05:00",
    type: "VirtualRide",
    name: "Easy recovery spin",
    movingTime: 2_700,
    distance: 21_300,
    icuTrainingLoad: 23,
    averageWatts: 142,
    averageHeartrate: 118,
    maxHeartrate: 131,
    totalElevationGain: 0,
  },
  {
    id: 90403,
    dayOffset: -4,
    startTime: "06:45:00",
    type: "VirtualRide",
    name: "Threshold 3 x 12",
    movingTime: 4_020,
    distance: 33_800,
    icuTrainingLoad: 88,
    averageWatts: 224,
    averageHeartrate: 152,
    maxHeartrate: 174,
    totalElevationGain: 0,
  },
  {
    id: 90404,
    dayOffset: -6,
    startTime: "08:30:00",
    type: "Ride",
    name: "Endurance hills",
    movingTime: 9_480,
    distance: 74_900,
    icuTrainingLoad: 117,
    averageWatts: 183,
    averageHeartrate: 139,
    maxHeartrate: 166,
    totalElevationGain: 1_120,
  },
  {
    id: 90405,
    dayOffset: -11,
    startTime: "09:00:00",
    type: "Ride",
    name: "Long steady ride",
    movingTime: 12_600,
    distance: 98_200,
    icuTrainingLoad: 141,
    averageWatts: 176,
    averageHeartrate: 136,
    maxHeartrate: 162,
    totalElevationGain: 880,
  },
  {
    id: 90406,
    dayOffset: -13,
    startTime: "06:50:00",
    type: "VirtualRide",
    name: "Sweet spot 2 x 20",
    movingTime: 4_500,
    distance: 37_100,
    icuTrainingLoad: 79,
    averageWatts: 216,
    averageHeartrate: 149,
    maxHeartrate: 168,
    totalElevationGain: 0,
  },
];

const WELLNESS_SEEDS: readonly WellnessSeed[] = Array.from({ length: 14 }, (_, index) => {
  const dayOffset = index - 13;
  return {
    dayOffset,
    fitness: 52 + Math.round(index * 0.7),
    fatigue: 55 + ((index * 5) % 13),
    restingHR: 48 + (index % 3),
    hrv: 64 + ((index * 7) % 11),
    sleepSecs: 25_200 + ((index * 1_800) % 5_400),
  };
});

export const RECENT_RIDE_ID = 90401;

export function weeklyLoad(): number {
  return ACTIVITY_SEEDS.filter((seed) => seed.dayOffset >= -6 && seed.dayOffset <= 0).reduce(
    (sum, seed) => sum + seed.icuTrainingLoad,
    0,
  );
}

export function dateKey(today: Date, dayOffset: number): string {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + dayOffset);
  return day.toISOString().slice(0, 10);
}

export interface FixtureActivity extends Omit<ActivitySeed, "dayOffset" | "startTime"> {
  readonly startDateLocal: string;
  readonly icuFtp: number;
}

export type FixtureWellnessDay = Omit<WellnessSeed, "dayOffset"> & {
  readonly id: string;
  readonly weight: number | null;
  readonly sleepQuality: number | null;
};

export interface FixtureLap {
  readonly index: number;
  readonly movingTime: number;
  readonly distance: number;
  readonly averageWatts: number;
  readonly averageHeartrate: number;
}

export interface AthleteFixture {
  readonly athlete: Readonly<Record<string, unknown>>;
  readonly wellness: readonly FixtureWellnessDay[];
  readonly activities: readonly FixtureActivity[];
  readonly laps: (id: number) => readonly FixtureLap[];
  readonly streams: (id: number) => Readonly<Record<string, readonly number[]>>;
}

function lapsFor(activity: FixtureActivity): FixtureLap[] {
  const count = Math.max(1, Math.round(activity.movingTime / 1_800));
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    movingTime: Math.round(activity.movingTime / count),
    distance: Math.round(activity.distance / count),
    averageWatts: activity.averageWatts + ((index * 9) % 23) - 11,
    averageHeartrate: activity.averageHeartrate + ((index * 5) % 9) - 4,
  }));
}

function streamsFor(activity: FixtureActivity): Record<string, number[]> {
  const samples = 240;
  const step = Math.round(activity.movingTime / samples);
  const wave = (index: number, period: number, amplitude: number): number =>
    Math.round(Math.sin((index / period) * Math.PI * 2) * amplitude);
  return {
    time: Array.from({ length: samples }, (_, index) => index * step),
    watts: Array.from({ length: samples }, (_, index) => activity.averageWatts + wave(index, 37, 48)),
    heartrate: Array.from({ length: samples }, (_, index) => activity.averageHeartrate + wave(index, 53, 11)),
    cadence: Array.from({ length: samples }, (_, index) => 88 + wave(index, 29, 6)),
    altitude: Array.from({ length: samples }, (_, index) => 210 + wave(index, 120, 85)),
  };
}

export function buildAthleteFixture(setting: DataSetting, today: Date): AthleteFixture {
  const ftp = setting === "implausible-ftp" ? IMPLAUSIBLE_FTP_WATTS : FIXTURE_FTP_WATTS;
  const activities = ACTIVITY_SEEDS.map(({ dayOffset, startTime, ...seed }) => ({
    ...seed,
    startDateLocal: `${dateKey(today, dayOffset)}T${startTime}`,
    icuFtp: ftp,
  }));
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  return {
    athlete: {
      id: "0",
      name: "Eval Rider",
      sex: "F",
      icuFtp: ftp,
      icuWeight: 64,
      icuMaxHr: 186,
      icuLthr: 166,
      icuRestingHr: 48,
      sportSettings: [{ types: ["Ride", "VirtualRide"], ftp, lthr: 166, maxHr: 186 }],
    },
    wellness: WELLNESS_SEEDS.map(({ dayOffset, ...seed }) => ({
      ...seed,
      id: dateKey(today, dayOffset),
      weight: null,
      sleepQuality: null,
    })),
    activities,
    laps: (id) => {
      const activity = byId.get(id);
      return activity === undefined ? [] : lapsFor(activity);
    },
    streams: (id) => {
      const activity = byId.get(id);
      return activity === undefined ? {} : streamsFor(activity);
    },
  };
}
