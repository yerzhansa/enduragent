import { describe, expect, it } from "vitest";
import {
  ATHLETE_SNAPSHOT_FALLBACK,
  ATHLETE_SNAPSHOT_HEADING,
  ATHLETE_SNAPSHOT_TIMEOUT_MS,
  AthleteSnapshotTimeoutError,
  LATEST_WELLNESS_LOOKBACK_DAYS,
  loadAthleteSnapshotBlock,
  renderAthleteSnapshotBlock,
  renderLatestWellnessLine,
} from "../src/agent/athlete-snapshot.js";
import { estimateTokens } from "../src/agent/token-utils.js";
import { projectAthlete } from "../src/sport/list-projection.js";
import type { AthleteDataReaderPort } from "../src/host-ports.js";
import { SubjectiveScoreSchema, type WellnessDay } from "@enduragent/kernel/reference/schemas";

const CYCLING_TYPES = ["Ride", "VirtualRide"];

const platformAthlete = {
  id: "i12345",
  name: "Test Athlete",
  email: "test@example.com",
  icuApiKey: "secret",
  icuFtp: 250,
  icuMaxHr: 185,
  icuLthr: 150,
  icuRestingHr: 47,
  icuWeight: 70,
  sportSettings: [
    { types: ["Run"], lthr: 170, thresholdPace: 3.9 },
    { types: ["Ride", "VirtualRide"], ftp: 250, lthr: 152, maxHr: 185, powerZones: [138, 188] },
  ],
};

const decodedAthlete = {
  id: "i12345",
  name: "Test Athlete",
  email: "test@example.com",
  city: "Test City",
  country: "US",
  sex: "M",
  weight: 71,
  icuFtp: 250,
  icuRestingHr: 47,
  icuMaxHr: 185,
  icuLthr: 152,
  icuDateOfBirth: "1992-06-15",
  locale: "en",
  timezone: "Europe/Amsterdam",
  icuApiKey: "secret",
};

const score = (value: number) => SubjectiveScoreSchema.parse(value);
const day = (values: Partial<WellnessDay> & { id: string }): WellnessDay => ({
  weight: null,
  restingHR: null,
  hrv: null,
  sleepSecs: null,
  sleepQuality: null,
  ...values,
});

const wellnessDays = [
  day({ id: "1998-07-04", fitness: 54, fatigue: 50, restingHR: 47, hrv: 73, sleepSecs: 28200, weight: 75 }),
  day({ id: "1998-07-05", fitness: 55, fatigue: 48, restingHR: 46, hrv: 75, sleepSecs: 28800, sleepQuality: 3 }),
];

describe("renderAthleteSnapshotBlock", () => {
  it("renders the projected profile and the newest wellness row with its date", () => {
    const block = renderAthleteSnapshotBlock({
      athlete: platformAthlete,
      wellness: wellnessDays,
      sportTypes: CYCLING_TYPES,
    });
    expect(block).toBe(
      `${ATHLETE_SNAPSHOT_HEADING}\n\n` +
        "Profile: FTP 250 W · LTHR 152 bpm · max HR 185 bpm · resting HR 47 bpm · weight 70 kg\n" +
        "Wellness 1998-07-05: Fitness 55 · Fatigue 48 · Form +7 · resting HR 46 bpm · HRV 75 · sleep 8h00 · sleep quality 3\n" +
        "Fetch wellness or activities only for a date range or history not shown here. " +
        "Treat a single HRV or resting-HR value as one signal, not a verdict; weigh the athlete's reported feel at least as much.",
    );
    expect(block).not.toContain("secret");
    expect(block).not.toContain("test@example.com");
    expect(estimateTokens(block!)).toBeLessThan(300);
  });

  it("keeps max HR and LTHR from a decoded athlete shaped like the library type", () => {
    const projected = projectAthlete(decodedAthlete);
    expect(projected).toEqual({
      id: "i12345",
      name: "Test Athlete",
      sex: "M",
      weight: 71,
      icuFtp: 250,
      icuRestingHr: 47,
      icuMaxHr: 185,
      icuLthr: 152,
      icuDateOfBirth: "1992-06-15",
    });
    const block = renderAthleteSnapshotBlock({
      athlete: decodedAthlete,
      wellness: [],
      sportTypes: CYCLING_TYPES,
    });
    expect(block).toContain(
      "Profile: FTP 250 W · LTHR 152 bpm · max HR 185 bpm · resting HR 47 bpm · weight 71 kg",
    );
  });

  it("reads the store-lane shape: snake_case sport settings and decimal load averages", () => {
    const block = renderAthleteSnapshotBlock({
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 240, indoor_ftp: 230, lthr: 150 }] },
      wellness: [day({ id: "1998-07-05", fitness: 60.3, fatigue: 70.6, hrv: 62 })],
      sportTypes: CYCLING_TYPES,
    });
    expect(block).toContain("Profile: FTP 240 W · LTHR 150 bpm");
    expect(block).toContain("Wellness 1998-07-05: Fitness 60.3 · Fatigue 70.6 · Form -10.3 · HRV 62");
  });

  it("returns undefined when neither profile nor wellness carries data", () => {
    expect(renderAthleteSnapshotBlock({ sportTypes: CYCLING_TYPES })).toBeUndefined();
    expect(
      renderAthleteSnapshotBlock({ athlete: { name: "x" }, wellness: [], sportTypes: CYCLING_TYPES }),
    ).toBeUndefined();
    expect(
      renderAthleteSnapshotBlock({
        athlete: undefined,
        wellness: [day({ id: "1998-07-05" })],
        sportTypes: CYCLING_TYPES,
      }),
    ).toBeUndefined();
  });

  it("prints a logged fatigue score as reported fatigue, never as the load Fatigue", () => {
    const line = renderLatestWellnessLine([day({ id: "1998-07-05", subjectiveFatigue: score(3) })]);
    expect(line).toBe("Wellness 1998-07-05: reported fatigue 3");
  });

  it("skips a newest row that carries no values and falls back to the previous dated row", () => {
    const line = renderLatestWellnessLine([
      day({ id: "1998-07-06" }),
      day({ id: "1998-07-05", restingHR: 46 }),
      day({ id: "1998-07-01", restingHR: 50 }),
    ]);
    expect(line).toBe("Wellness 1998-07-05: resting HR 46 bpm");
  });
});

describe("projectAthlete", () => {
  it("keeps only coaching fields and projects each sport-settings row", () => {
    const projected = projectAthlete(platformAthlete);
    expect(Object.keys(projected).sort()).toEqual(
      ["id", "name", "icuFtp", "icuLthr", "icuMaxHr", "icuRestingHr", "icuWeight", "sportSettings"].sort(),
    );
    expect(projected.sportSettings).toEqual([
      { types: ["Run"], lthr: 170, thresholdPace: 3.9 },
      { types: ["Ride", "VirtualRide"], ftp: 250, lthr: 152, maxHr: 185, powerZones: [138, 188] },
    ]);
  });
});

describe("loadAthleteSnapshotBlock", () => {
  function reader(overrides: Partial<AthleteDataReaderPort>): AthleteDataReaderPort {
    const unavailable = async () => ({
      ok: false as const,
      error: "store_read_unavailable" as const,
      message: "no snapshot",
    });
    return {
      getAthlete: unavailable,
      listWellness: unavailable,
      listActivities: unavailable,
      getActivity: unavailable,
      getStreams: unavailable,
      listCalendar: unavailable,
      freshness: () => undefined,
      ...overrides,
    };
  }

  it("asks for the lookback window ending today and renders both reads", async () => {
    let requested: { start: string; end?: string } | undefined;
    const block = await loadAthleteSnapshotBlock({
      reader: reader({
        getAthlete: async () => ({ ok: true, value: platformAthlete }),
        listWellness: async (input) => {
          requested = input;
          return { ok: true, value: wellnessDays };
        },
      }),
      today: "1998-07-06",
      sportTypes: CYCLING_TYPES,
    });
    expect(requested).toEqual({ start: "1998-06-30", end: "1998-07-06" });
    expect(LATEST_WELLNESS_LOOKBACK_DAYS).toBe(7);
    expect(block).toContain("Profile: FTP 250 W");
    expect(block).toContain("Wellness 1998-07-05:");
  });

  it("omits the block without a reader, on a failed read, or when reads throw", async () => {
    expect(
      await loadAthleteSnapshotBlock({ reader: undefined, today: "1998-07-06", sportTypes: [] }),
    ).toBeUndefined();
    expect(
      await loadAthleteSnapshotBlock({ reader: reader({}), today: "1998-07-06", sportTypes: [] }),
    ).toBeUndefined();
    const errors: unknown[] = [];
    const block = await loadAthleteSnapshotBlock({
      reader: reader({
        getAthlete: async () => {
          throw new Error("network down");
        },
        listWellness: async () => ({ ok: true, value: wellnessDays }),
      }),
      today: "1998-07-06",
      sportTypes: CYCLING_TYPES,
      onError: (error) => errors.push(error),
    });
    expect(errors).toHaveLength(1);
    expect(block).not.toContain("Profile:");
    expect(block).toContain("Wellness 1998-07-05:");
  });

  it("prints the reader's fault sentence under the profile when wellness could not be read", async () => {
    const block = await loadAthleteSnapshotBlock({
      reader: reader({
        getAthlete: async () => ({ ok: true, value: platformAthlete }),
        listWellness: async () => ({
          ok: false,
          error: "wellness_unreadable",
          message: "Wellness data could not be read. This is a fault in reading it, not missing athlete data.",
        }),
      }),
      today: "1998-07-06",
      sportTypes: CYCLING_TYPES,
    });
    expect(block).toContain(
      "weight 70 kg\nWellness data could not be read. This is a fault in reading it, not missing athlete data.\n",
    );
    expect(block).not.toContain(ATHLETE_SNAPSHOT_FALLBACK);
  });

  it("still tells the coach to fetch the profile when neither it nor wellness could be read", async () => {
    const block = await loadAthleteSnapshotBlock({
      reader: reader({
        listWellness: async () => ({
          ok: false,
          error: "wellness_unreadable",
          message: "Wellness data could not be read. This is a fault in reading it, not missing athlete data.",
        }),
      }),
      today: "1998-07-06",
      sportTypes: CYCLING_TYPES,
    });
    expect(block).toBe(
      `${ATHLETE_SNAPSHOT_FALLBACK}\nWellness data could not be read. This is a fault in reading it, not missing athlete data.`,
    );
  });

  it("prints a reader's notice under the latest wellness line", async () => {
    const block = await loadAthleteSnapshotBlock({
      reader: reader({
        listWellness: async () => ({
          ok: true,
          value: wellnessDays,
          notice: "Wellness is incomplete: 1 of 3 days could not be read and are missing here.",
        }),
      }),
      today: "1998-07-06",
      sportTypes: CYCLING_TYPES,
    });
    expect(block).toContain(
      "sleep quality 3\nWellness is incomplete: 1 of 3 days could not be read and are missing here.\n",
    );
  });

  it("gives up after the deadline and reports the timeout", async () => {
    expect(ATHLETE_SNAPSHOT_TIMEOUT_MS).toBe(5_000);
    const errors: unknown[] = [];
    const block = await loadAthleteSnapshotBlock({
      reader: reader({
        getAthlete: () => new Promise(() => undefined),
        listWellness: async () => ({ ok: true, value: wellnessDays }),
      }),
      today: "1998-07-06",
      sportTypes: CYCLING_TYPES,
      timeoutMs: 20,
      onError: (error) => errors.push(error),
    });
    expect(block).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AthleteSnapshotTimeoutError);
  });
});
