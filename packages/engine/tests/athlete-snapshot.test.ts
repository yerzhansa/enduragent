import { describe, expect, it } from "vitest";
import {
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

const platformWellness = [
  { id: "1998-07-04", ctl: 54, atl: 50, restingHR: 47, hrv: 73, sleepSecs: 28200, weight: 75 },
  { id: "1998-07-05", ctl: 55, atl: 48, restingHR: 46, hrv: 75, sleepSecs: 28800, sleepQuality: 3 },
];

describe("renderAthleteSnapshotBlock", () => {
  it("renders the projected profile and the newest wellness row with its date", () => {
    const block = renderAthleteSnapshotBlock({
      athlete: platformAthlete,
      wellness: platformWellness,
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

  it("reads the store-lane shape: snake_case sport settings and renamed fitness fields", () => {
    const block = renderAthleteSnapshotBlock({
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 240, indoor_ftp: 230, lthr: 150 }] },
      wellness: [{ id: "1998-07-05", fitness: 60.3, fatigue: 70.6, restingHR: null, hrv: 62 }],
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
        wellness: [{ id: "1998-07-05", restingHR: null }],
        sportTypes: CYCLING_TYPES,
      }),
    ).toBeUndefined();
  });

  it("skips a newest row that carries no values and falls back to the previous dated row", () => {
    const line = renderLatestWellnessLine([
      { id: "1998-07-06", restingHR: null },
      { id: "1998-07-05", restingHR: 46 },
      { id: "1998-07-01", restingHR: 50 },
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
          return { ok: true, value: platformWellness };
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
        listWellness: async () => ({ ok: true, value: platformWellness }),
      }),
      today: "1998-07-06",
      sportTypes: CYCLING_TYPES,
      onError: (error) => errors.push(error),
    });
    expect(errors).toHaveLength(1);
    expect(block).not.toContain("Profile:");
    expect(block).toContain("Wellness 1998-07-05:");
  });

  it("gives up after the deadline and reports the timeout", async () => {
    expect(ATHLETE_SNAPSHOT_TIMEOUT_MS).toBe(5_000);
    const errors: unknown[] = [];
    const block = await loadAthleteSnapshotBlock({
      reader: reader({
        getAthlete: () => new Promise(() => undefined),
        listWellness: async () => ({ ok: true, value: platformWellness }),
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
