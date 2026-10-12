import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlatformAthleteDataReader,
  createPureCoreIntervalsTools,
  createStoreAthleteDataReader,
  type IntervalsClient,
} from "@enduragent/core";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { describe, expect, it } from "vitest";
import { runReferenceCapture } from "../src/capture.js";
import { createLocalBundleProducer } from "../src/local-bundle-producer.js";

const CAPTURE_ID = "12345678-1234-4123-8123-123456789abc";
const NOW = new Date("1998-07-18T12:00:00.000Z");

const profile = {
  sportSettings: [
    {
      id: 7,
      athlete_id: "synthetic-athlete",
      types: ["Ride"],
      updated: "1998-07-01T00:00:00.000Z",
      ftp: 250,
      lthr: 165,
      power_zones: [0, 125, 200, 250],
    },
  ],
};
const activities = [
  {
    id: 42,
    type: "Ride",
    start_date: "1998-07-17T10:00:00.000Z",
    start_date_local: "1998-07-17T12:00:00",
    moving_time: 3600,
    elapsed_time: 3700,
    distance: 40_000,
  },
];
const wellness = [
  {
    id: "1998-07-17",
    weight: 70,
    restingHR: 50,
    hrv: 60,
    sleepSecs: 28_800,
    sleepQuality: 3,
    sportInfo: [{ type: "Ride", eftp: 245 }],
  },
];
const streams = { time: [0, 1], watts: [200, 210], heartrate: [140, 145] };

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runReferenceCapture", () => {
  it("persists a synthetic four-lane capture and commits its manifest only after pinned evidence exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-capture-home-"));
    const requests: string[] = [];
    const baseFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/streams.json")) return json(streams);
      if (url.includes("/activities?")) {
        return json([
          ...activities,
          {
            id: 43,
            type: "Ride",
            start_date: "1998-04-24T10:00:00.000Z",
            start_date_local: "1998-04-24T12:00:00",
            moving_time: null,
            elapsed_time: 3_700,
            distance: 40_000,
          },
        ]);
      }
      if (url.includes("/wellness?")) return json(wellness);
      return json(profile);
    };
    let monotonic = 0;
    const manifest = await runReferenceCapture(
      {
        env: { ENDURAGENT_HOME: root },
        apiKey: "synthetic-key",
        athleteId: "synthetic-athlete",
        calendarTimeZone: "UTC",
        reviewedOn: "1998-07-18",
        reason: "initial",
        baseFetch,
      },
      {
        wallClock: () => NOW,
        uuid: () => CAPTURE_ID,
        monotonicNow: () => (monotonic += 250),
        sleep: async () => {},
      },
    );
    expect(requests).toHaveLength(4);
    expect(manifest.plan.frozenNow).toMatch(/^1998-07-18T/);
    expect(manifest.records.settings).toHaveLength(1);
    expect(manifest.records.activities).toHaveLength(1);
    expect(manifest.records.wellness).toHaveLength(1);
    expect(manifest.records.streams).toHaveLength(1);
    expect(manifest.records.activities[0]?.store_evidence.current_revision).not.toBeNull();
    expect(manifest.records.wellness[0]?.store_evidence.current_revision).toBeNull();
    expect((await stat(join(root, "captures", CAPTURE_ID, "manifest.json"))).mode & 0o777).toBe(
      0o444,
    );

    const store = openSqliteStorage(join(root, "store", "store.db"));
    expect((await store.get("SELECT count(*) AS n FROM source_artifact"))?.n).toBe(4);
    expect((await store.get("SELECT count(*) AS n FROM wellness"))?.n).toBe(1);
    expect((await store.get("SELECT count(*) AS n FROM anchor_history"))?.n).toBeGreaterThan(0);
    expect((await store.get("SELECT count(*) AS n FROM zone_set_history"))?.n).toBeGreaterThan(0);
    expect((await store.get("SELECT count(*) AS n FROM raw_file"))?.n).toBe(0);
    expect(
      await store.get(
        `SELECT authority_kind, authority_id, calendar_timezone, covered_oldest_date_key,
  covered_newest_date_key, gap_state, dropped_local_dates_json, undated_dropped_count
FROM training_history_coverage_commit`,
      ),
    ).toEqual({
      authority_kind: "reference-capture",
      authority_id: CAPTURE_ID,
      calendar_timezone: "UTC",
      covered_oldest_date_key: 19980425,
      covered_newest_date_key: 19980717,
      gap_state: "none",
      dropped_local_dates_json: "[]",
      undated_dropped_count: 0,
    });
    await store.close();
  });

  it("returns captured wellness to the coach with the load average and the logged fatigue score apart", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-capture-home-"));
    const days = [
      { id: "1998-07-16", restingHR: 48, hrv: 62.5, sleepSecs: 27_000, ctl: 31.2, atl: 27.787529, rampRate: 1.5, fatigue: null },
      { id: "1998-07-17", restingHR: 50, hrv: 60, sleepSecs: 28_800, ctl: 31.6, atl: 29.1, rampRate: 1.4, fatigue: 3 },
    ];
    const baseFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/streams.json")) return json(streams);
      if (url.includes("/activities?")) return json(activities);
      if (url.includes("/wellness?")) return json(days);
      return json(profile);
    };
    let monotonic = 0;
    const manifest = await runReferenceCapture(
      {
        env: { ENDURAGENT_HOME: root },
        apiKey: "synthetic-key",
        athleteId: "synthetic-athlete",
        calendarTimeZone: "UTC",
        reviewedOn: "1998-07-18",
        reason: "initial",
        baseFetch,
      },
      {
        wallClock: () => NOW,
        uuid: () => CAPTURE_ID,
        monotonicNow: () => (monotonic += 250),
        sleep: async () => {},
      },
    );
    expect(manifest.records.wellness.map((record) => record.external_id)).toEqual(["1998-07-16", "1998-07-17"]);

    const store = openSqliteStorage(join(root, "store", "store.db"));
    expect(await store.all("SELECT date_key, resting_hr, fatigue FROM wellness ORDER BY date_key")).toEqual([
      { date_key: 19980716, resting_hr: 48, fatigue: null },
      { date_key: 19980717, resting_hr: 50, fatigue: 3 },
    ]);
    await store.close();

    const snapshot = await createLocalBundleProducer({
      storePath: join(root, "store", "store.db"),
      archiveRoot: join(root, "archive"),
    }).produce(manifest);
    const reader = createStoreAthleteDataReader({ snapshot: () => snapshot, clockNow: () => NOW.getTime() });
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_wellness;
    if (!tool?.execute) throw new Error("Wellness tool missing");
    const result = await tool.execute(
      { oldest: "1998-07-16", newest: "1998-07-17" },
      { toolCallId: "wellness-roundtrip", messages: [] },
    );
    expect(result).toMatchObject({
      data: [
        { id: "1998-07-16", fitness: 31.2, fatigue: 27.787529, weeklyFitnessChange: 1.5, restingHR: 48, hrv: 62.5 },
        { id: "1998-07-17", fitness: 31.6, fatigue: 29.1, subjectiveFatigue: 3, restingHR: 50, sleepSecs: 28_800 },
      ],
    });
    expect((result as { data: object[] }).data[0]).not.toHaveProperty("subjectiveFatigue");

    const client = { wellness: { list: async () => ({ ok: true as const, value: days }) } } as unknown as IntervalsClient;
    const liveTool = createPureCoreIntervalsTools(client, "UTC", createPlatformAthleteDataReader(client))
      .intervals_fetch_wellness;
    if (!liveTool?.execute) throw new Error("Wellness tool missing");
    const live = await liveTool.execute(
      { oldest: "1998-07-16", newest: "1998-07-17" },
      { toolCallId: "wellness-live", messages: [] },
    );
    expect(live).toEqual((result as { data: object[] }).data);
  });

  it("rolls back an activity landing when the in-transaction coverage commit conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-capture-home-"));
    const fetchFor =
      (activityId: number): typeof globalThis.fetch =>
      async (input) => {
        const url = String(input);
        if (url.includes("/streams.json")) return json(streams);
        if (url.includes("/activities?")) return json([{ ...activities[0], id: activityId }]);
        if (url.includes("/wellness?")) return json(wellness);
        return json(profile);
      };
    let monotonic = 0;
    const dependencies = {
      wallClock: () => NOW,
      uuid: () => CAPTURE_ID,
      monotonicNow: () => (monotonic += 250),
      sleep: async () => {},
    };
    await runReferenceCapture(
      {
        env: { ENDURAGENT_HOME: root },
        apiKey: "synthetic-key",
        athleteId: "synthetic-athlete",
        calendarTimeZone: "UTC",
        reviewedOn: "1998-07-18",
        reason: "initial",
        baseFetch: fetchFor(42),
      },
      dependencies,
    );

    await expect(
      runReferenceCapture(
        {
          env: { ENDURAGENT_HOME: root },
          apiKey: "synthetic-key",
          athleteId: "synthetic-athlete",
          calendarTimeZone: "Asia/Almaty",
          reviewedOn: "1998-07-18",
          reason: "initial",
          baseFetch: fetchFor(43),
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ cause: { category: "persistence" } });

    const store = openSqliteStorage(join(root, "store", "store.db"));
    expect(
      await store.get(
        "SELECT count(*) AS n FROM source_record WHERE source='intervals-icu' AND external_id='43'",
      ),
    ).toEqual({ n: 0 });
    expect(await store.get("SELECT count(*) AS n FROM training_history_coverage_commit")).toEqual({
      n: 1,
    });
    await store.close();
  });

  it("commits a capture whose activities lane has no retained members", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-capture-home-"));
    const requests: string[] = [];
    const baseFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/activities?")) return json([]);
      if (url.includes("/wellness?")) return json(wellness);
      return json(profile);
    };
    let monotonic = 0;
    const manifest = await runReferenceCapture(
      {
        env: { ENDURAGENT_HOME: root },
        apiKey: "synthetic-key",
        athleteId: "synthetic-athlete",
        calendarTimeZone: "UTC",
        reviewedOn: "1998-07-18",
        reason: "initial",
        baseFetch,
      },
      {
        wallClock: () => NOW,
        uuid: () => CAPTURE_ID,
        monotonicNow: () => (monotonic += 250),
        sleep: async () => {},
      },
    );
    expect(requests).toHaveLength(3);
    expect(manifest.records.activities).toEqual([]);
    expect(manifest.selected_stream_ids).toEqual([]);
    expect(manifest.captured_stream_ids).toEqual([]);
    expect(manifest.deterministic_order.activities).toEqual([]);
    expect(
      JSON.parse(await readFile(join(root, "captures", CAPTURE_ID, "manifest.json"), "utf8")),
    ).toMatchObject({ records: { activities: [] } });
    const store = openSqliteStorage(join(root, "store", "store.db"));
    expect(
      await store.get("SELECT authority_kind, authority_id FROM training_history_coverage_commit"),
    ).toEqual({ authority_kind: "reference-capture", authority_id: CAPTURE_ID });
    await store.close();
  });
});
