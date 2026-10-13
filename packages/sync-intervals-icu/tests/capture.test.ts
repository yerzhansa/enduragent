import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { createReferenceCapturePlan } from "@enduragent/kernel/reference/capture";
import type { SyncBudget } from "@enduragent/kernel/store";
import { describe, expect, it } from "vitest";
import { SyncBudgetExceededError } from "../src/http.js";
import { activityDropEvidence } from "../src/lane-report.js";
import { createIntervalsIcuSource } from "../src/source.js";

const NOW = new Date("1998-07-18T12:00:00.000Z");
const PLAN = createReferenceCapturePlan({ now: NOW, calendarTimeZone: "UTC" });
const PROFILE = { sportSettings: [{ id: 7, athlete_id: "synthetic-athlete", types: ["Ride"], updated: "1998-07-01T00:00:00.000Z", ftp: 250 }] };
const ACTIVITY = { id: 42, type: "Ride", start_date: "1998-07-17T10:00:00.000Z",
  start_date_local: "1998-07-17T12:00:00", moving_time: 3600, elapsed_time: 3700, distance: 40_000 };
const WELLNESS = { id: "1998-07-17", restingHR: 50, hrv: 71.5, sleepSecs: 28_800, ctl: 31.2, atl: 27.787529, rampRate: 1.5, fatigue: null };

function response(value: unknown, status = 200, contentType = "application/json") {
  return { status, headers: { "content-type": contentType }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function budget(maxArtifacts = 20, overrides: Partial<SyncBudget> = {}): SyncBudget {
  return { signal: new AbortController().signal, clock: { monotonicNow: () => 1 }, deadlineMonotonicMs: 1_000,
    perRequestTimeoutMs: 1_000, maxRequests: 20, maxArtifacts, ...overrides };
}

function fixture(stream: unknown = { time: [0, 1], watts: [200, 210] }, activities: readonly unknown[] = [ACTIVITY],
  wellness: readonly unknown[] = [WELLNESS], overrides: { readonly profile?: unknown; readonly streamStatus?: number;
    readonly streamRequest?: () => ReturnType<typeof response> } = {}) {
  const requests: string[] = [], writes: { payload: unknown; epoch: number }[] = [];
  const queue = [response(overrides.profile ?? PROFILE), response(activities), response(wellness),
    response(stream, overrides.streamStatus ?? 200)];
  const source = createIntervalsIcuSource({ athleteId: "synthetic-athlete", historyNewestDate: "1998-07-18",
    minRequestIntervalMs: 250, wallClock: { now: () => NOW.getTime() }, sleep: async () => {},
    httpFactory: () => ({ fetch: async (request) => { requests.push(request.url);
      return requests.length > 3 && overrides.streamRequest !== undefined ? overrides.streamRequest() : queue.shift()!; } }),
    archive: {
      async writeSnapshot(payload, instant) { writes.push({ payload, epoch: instant.epochSeconds });
        const address = createHash("sha256").update(canonicalJson(payload)).update(String(instant.epochSeconds)).digest("hex");
        return { address, relPath: `1998/07/${address}.json.gz`, deduped: false }; },
      async writeArtifact() { throw new Error("unused"); }, async quarantine() { throw new Error("unused"); },
      async readArtifact() { throw new Error("unused"); }, async readSnapshot() { throw new Error("unused"); }, async has() { return false; },
    },
    acl: { activity: (row) => row,
      streams(value) { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("bad stream"); return value as Record<string, unknown>; },
      assertClean() {} },
  });
  return { source, requests, writes };
}

describe("captureReference", () => {
  it("uses the caller plan's non-UTC civil window for both ranged endpoints", async () => {
    const value = fixture();
    const plan = createReferenceCapturePlan({
      now: new Date("1998-07-18T20:30:00.000Z"),
      calendarTimeZone: "Asia/Almaty",
    });

    await value.source.captureReference(plan, budget());

    expect(value.requests[1]).toContain("oldest=1998-04-26&newest=1998-07-19");
    expect(value.requests[2]).toContain("oldest=1998-04-26&newest=1998-07-19");
  });

  it("fetches exact endpoints in selector order and archives whole/member evidence after fetch", async () => {
    const value = fixture(), batch = await value.source.captureReference(PLAN, budget());
    expect(value.requests).toHaveLength(4);
    expect(value.requests[0]).toMatch(/\/api\/v1\/athlete\/synthetic-athlete$/);
    expect(value.requests[1]).toContain("/activities?oldest=");
    expect(value.requests[2]).toContain("/wellness?oldest=");
    expect(value.requests[3]).toContain("/api/v1/activity/42/streams.json?types=time&types=watts&types=heartrate&types=dfa_a1&types=artifacts&includeDefaults=false");
    expect(batch.selected_stream_ids).toEqual(["42"]);
    expect(batch.captured_stream_ids).toEqual(["42"]);
    expect(batch.records.settings[0]?.externalId).toMatch(/^settings:/);
    expect(batch.records.activities[0]?.externalId).toBe("42");
    expect(batch.records.wellness[0]?.externalId).toBe("1998-07-17");
    expect(batch.records.streams[0]?.externalId).toBe("streams:42");
    expect(batch.records.streams[0]?.archive).toBe(batch.endpoints[3]?.archive);
    expect(value.writes).toHaveLength(7);
  });

  it("splits the activity rows the capture drops into source-restricted and other", async () => {
    const stub = { id: "9001", icu_athlete_id: "i12345", start_date_local: "1998-07-17T14:08:41", source: "STRAVA" };
    const foreign = { id: "9002", icu_athlete_id: "i12345", source: "GARMIN_CONNECT" };
    const value = fixture({ time: [0, 1], watts: [200, 210] }, [ACTIVITY, stub, foreign]);

    const batch = await value.source.captureReference(PLAN, budget());

    expect(batch.records.activities).toHaveLength(1);
    expect(batch.report.activities).toEqual({
      fetched: 3,
      landed: 1,
      drops: [
        { lane: "activities", payloadIndex: 1, externalId: "9001", localDate: "1998-07-17", phase: "decode",
          reason: "source-restricted", field: null, errorName: null },
        { lane: "activities", payloadIndex: 2, externalId: "9002", localDate: null, phase: "decode",
          reason: "unclassified", field: null, errorName: "TypeError" },
      ],
      unfetched: [],
    });
    expect(activityDropEvidence(batch.report.activities)).toEqual({
      sourceRestricted: 1,
      other: 1,
      datedLocalDates: ["1998-07-17"],
      undatedCount: 1,
    });
  });

  it("reports every lane as fully landed for a clean capture", async () => {
    const batch = await fixture().source.captureReference(PLAN, budget());
    const clean = { fetched: 1, landed: 1, drops: [], unfetched: [] };
    expect(batch.report).toEqual({ settings: clean, activities: clean, wellness: clean, streams: clean });
    expect(activityDropEvidence(batch.report.activities)).toEqual({
      sourceRestricted: 0,
      other: 0,
      datedLocalDates: [],
      undatedCount: 0,
    });
  });

  it("omits malformed stream responses without omitting required lanes", async () => {
    const value = fixture("invalid"), batch = await value.source.captureReference(PLAN, budget());
    expect(batch.selected_stream_ids).toEqual(["42"]);
    expect(batch.captured_stream_ids).toEqual([]);
    expect(batch.endpoints).toHaveLength(3);
    expect(batch.records.activities).toHaveLength(1);
  });

  it("reserves every selected stream artifact before requests or archives", async () => {
    const value = fixture();
    await expect(value.source.captureReference(PLAN, budget(6))).rejects.toThrow();
    expect(value.requests).toHaveLength(3);
    expect(value.writes).toHaveLength(0);
  });

  it("derives live membership in whole-payload encounter order and omits malformed members", async () => {
    const value = fixture(), plan = (await value.source.captureReference(PLAN, budget())).plan;
    const derived = await value.source.deriveReferenceCaptureMembers(plan, [
      { ordinal: 0, lane: "settings", endpoint: "athlete-profile", request: { oldest: null, newest: null, activity_id: null, stream_types: [], include_defaults: null }, payload: PROFILE },
      { ordinal: 1, lane: "activities", endpoint: "activities", request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, payload: [{ bad: true }, ACTIVITY] },
      { ordinal: 2, lane: "wellness", endpoint: "wellness", request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, payload: [{ id: "bad" }, WELLNESS] },
    ]);
    expect(derived.activities[0]?.payload_index).toBe(1);
    expect(derived.wellness[0]?.payload_index).toBe(1);
  });

  it("fails the derivation when landing a wellness day throws anything but a row rejection", async () => {
    const value = fixture(), plan = (await value.source.captureReference(PLAN, budget())).plan;
    const defect = { id: "1998-07-16", get restingHR(): number { throw new RangeError("landing defect"); } };
    const request = { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null };

    await expect(value.source.deriveReferenceCaptureMembers(plan, [
      { ordinal: 0, lane: "settings", endpoint: "athlete-profile", request: { ...request, oldest: null, newest: null }, payload: PROFILE },
      { ordinal: 1, lane: "activities", endpoint: "activities", request, payload: [ACTIVITY] },
      { ordinal: 2, lane: "wellness", endpoint: "wellness", request, payload: [WELLNESS, defect] },
    ])).rejects.toThrow("landing defect");
  });
});

describe("capture report", () => {
  const MARKER = "poison-marker-7f3a";

  it("counts every fetched wellness day and names the day and field that could not be stored", async () => {
    const days = [
      { ...WELLNESS, id: "1998-07-15" },
      { ...WELLNESS, id: "1998-07-16", restingHR: -1, comments: MARKER },
      { ...WELLNESS, id: "1998-07-17" },
    ];

    const batch = await fixture(undefined, undefined, days).source.captureReference(PLAN, budget());

    expect(batch.records.wellness.map((record) => record.externalId)).toEqual(["1998-07-15", "1998-07-17"]);
    expect(batch.report.wellness).toEqual({
      fetched: 3,
      landed: 2,
      drops: [{ lane: "wellness", payloadIndex: 1, externalId: "1998-07-16", localDate: "1998-07-16", phase: "landing",
        reason: "landing", field: "restingHR", errorName: null }],
      unfetched: [],
    });
    expect(JSON.stringify(batch.report)).not.toContain(MARKER);
  });

  it("keeps no id for a rejected wellness day whose id is not a date", async () => {
    const batch = await fixture(undefined, undefined, [WELLNESS, { ...WELLNESS, id: MARKER }])
      .source.captureReference(PLAN, budget());

    expect(batch.report.wellness.drops).toEqual([{ lane: "wellness", payloadIndex: 1, externalId: null, localDate: null,
      phase: "decode", reason: "identity", field: "id", errorName: null }]);
    expect(JSON.stringify(batch.report)).not.toContain(MARKER);
  });

  it("lists a recording whose download failed as unfetched, not as a fetched row", async () => {
    const batch = await fixture({}, undefined, undefined, { streamStatus: 404 }).source.captureReference(PLAN, budget());

    expect(batch.captured_stream_ids).toEqual([]);
    expect(batch.report.streams).toEqual({
      fetched: 0,
      landed: 0,
      drops: [],
      unfetched: [{ lane: "streams", payloadIndex: null, externalId: "streams:42", localDate: null, phase: "fetch",
        reason: "fetch", field: "http_404", errorName: null }],
    });
  });

  it("keeps no id for a recording whose activity id is free text", async () => {
    const batch = await fixture({}, [{ ...ACTIVITY, id: `free text / ${MARKER}` }], undefined, { streamStatus: 404 })
      .source.captureReference(PLAN, budget());

    expect(batch.report.streams.unfetched).toEqual([{ lane: "streams", payloadIndex: null, externalId: null, localDate: null,
      phase: "fetch", reason: "fetch", field: "http_404", errorName: null }]);
    expect(JSON.stringify(batch.report)).not.toContain(MARKER);
  });

  it("ends the capture when the request budget runs out while a recording download is retried", async () => {
    const capture = fixture(undefined, undefined, undefined, { streamRequest: () => response({}, 503) })
      .source.captureReference(PLAN, budget(20, { maxRequests: 5 }));

    await expect(capture).rejects.toBeInstanceOf(SyncBudgetExceededError);
  });

  it("ends the capture with the transport's error when the capture is aborted during a recording download", async () => {
    const controller = new AbortController();
    const capture = fixture(undefined, undefined, undefined, { streamRequest: () => {
      controller.abort();
      throw new Error("synthetic socket closed");
    } }).source.captureReference(PLAN, budget(20, { signal: controller.signal }));

    await expect(capture).rejects.toThrow("synthetic socket closed");
  });

  it("ends the capture when the deadline passes during a recording download that failed", async () => {
    let now = 1;
    const capture = fixture(undefined, undefined, undefined, { streamRequest: () => {
      now = 5_000;
      return response({}, 404);
    } }).source.captureReference(PLAN, budget(20, { clock: { monotonicNow: () => now } }));

    await expect(capture).rejects.toBeInstanceOf(SyncBudgetExceededError);
  });

  it("counts a downloaded recording that cannot be landed as a dropped row", async () => {
    const batch = await fixture("invalid").source.captureReference(PLAN, budget());

    expect(batch.report.streams).toEqual({
      fetched: 1,
      landed: 0,
      drops: [{ lane: "streams", payloadIndex: null, externalId: "streams:42", localDate: null, phase: "decode",
        reason: "unclassified", field: null, errorName: "TypeError" }],
      unfetched: [],
    });
  });

  it("counts a sport setting that cannot be landed", async () => {
    const profile = { sportSettings: [...PROFILE.sportSettings, { id: MARKER, athlete_id: "synthetic-athlete", types: ["Run"] }] };

    const batch = await fixture(undefined, undefined, undefined, { profile }).source.captureReference(PLAN, budget());

    expect(batch.report.settings).toEqual({
      fetched: 2,
      landed: 1,
      drops: [{ lane: "settings", payloadIndex: 1, externalId: null, localDate: null, phase: "decode",
        reason: "unclassified", field: null, errorName: "TypeError" }],
      unfetched: [],
    });
    expect(JSON.stringify(batch.report)).not.toContain(MARKER);
  });
});

describe("captured wellness", () => {
  async function landed(...days: readonly unknown[]) {
    const batch = await fixture(undefined, undefined, days).source.captureReference(PLAN, budget());
    return batch.records.wellness.map((record) => ({
      date: record.externalId,
      row: record.landing.row,
      fields: JSON.parse(record.landing.row.fields_json) as {
        subjectiveFatigue: number | null;
        load: Record<string, number | null>;
        values: Record<string, unknown>;
      },
    }));
  }

  it("lands a day whose short-term load is a decimal and stores the load apart from the score", async () => {
    const [day] = await landed(WELLNESS);

    expect(day?.date).toBe("1998-07-17");
    expect(day?.row.fatigue).toBeNull();
    expect(day?.row.resting_hr).toBe(50);
    expect(day?.fields.subjectiveFatigue).toBeNull();
    expect(day?.fields.load).toEqual({ fitness: 31.2, fatigue: 27.787529, fitnessContribution: null,
      fatigueContribution: null, weeklyFitnessChange: 1.5 });
    expect(Object.keys(day?.fields.values ?? {}).filter((key) => /fatigue|fitness/iu.test(key))).toEqual([]);
  });

  it("lands the fatigue score the athlete logged beside a decimal load", async () => {
    const [day] = await landed({ ...WELLNESS, fatigue: 3 });

    expect(day?.row.fatigue).toBe(3);
    expect(day?.fields.subjectiveFatigue).toBe(3);
    expect(day?.fields.load.fatigue).toBe(27.787529);
  });

  it("never lands a whole-number load as the fatigue score", async () => {
    const days = await landed({ ...WELLNESS, id: "1998-07-15", atl: 28, fatigue: null }, { ...WELLNESS, id: "1998-07-16", atl: 28, fatigue: 3 });

    expect(days.map((day) => [day.date, day.row.fatigue, day.fields.load.fatigue])).toEqual([
      ["1998-07-15", null, 28],
      ["1998-07-16", 3, 28],
    ]);
  });

  it("lands heart-rate variability SDNN from the key the platform sends", async () => {
    const [day] = await landed({ ...WELLNESS, hrvSDNN: 40.25 });

    expect(day?.row.hrv_sdnn).toBe(40.25);
  });
});
