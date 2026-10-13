import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import type { HttpPort, HttpResponse } from "@enduragent/kernel/ports";
import { RowRejection } from "@enduragent/kernel/reference/local-bundle";
import {
  createPhysicalRequestLedger,
  type PhysicalRequestLedger,
  type SourceWatermark,
  type SyncBudget,
} from "@enduragent/kernel/store";
import {
  advanceWindow,
  compactCursor,
  createIntervalsIcuSource,
  initialCursor,
  INTERVALS_ICU_CAPABILITIES,
  parseCursor,
} from "../src/index.js";

const json = (value: unknown): HttpResponse => ({ status: 200, headers: { "content-type": "application/json; charset=utf-8" },
  body: new TextEncoder().encode(JSON.stringify(value)) });
const activity = (id: string, date = "1998-01-05") => ({ id, start_date: `${date}T07:00:00Z`, start_date_local: `${date}T08:00:00`,
  type: "Ride", moving_time: 90, elapsed_time: 100, distance: 1_000 });

function archive(log: string[] = []): ArchiveManager {
  const values = new Map<string, unknown>();
  return {
    async writeSnapshot(value, when) { log.push(`archive:${Array.isArray(value) ? "page" : "row"}`);
      const address = createHash("sha256").update(canonicalJson(value)).digest("hex"), relPath = `${when.epochSeconds}/${address}.json.gz`;
      const deduped = values.has(relPath); values.set(relPath, structuredClone(value)); return { address, relPath, deduped }; },
    async writeArtifact(bytes, ext, when) { const address = createHash("sha256").update(bytes).digest("hex");
      return { address, relPath: `${when.epochSeconds}/${address}.${ext}`, deduped: false }; },
    async readSnapshot(path) { return structuredClone(values.get(path)); }, async has(path) { return values.has(path); },
    async readArtifact() { throw new Error("unused"); }, async quarantine() { throw new Error("unused"); },
  };
}

function budget(maxArtifacts = 100, maxRequests = 100): SyncBudget {
  return { signal: new AbortController().signal, clock: { monotonicNow: () => 0 }, deadlineMonotonicMs: 1_000_000,
    perRequestTimeoutMs: 30_000, maxRequests, maxArtifacts };
}

function source(http: HttpPort, options: { oldest?: string; newest?: string; archive?: ArchiveManager;
  log?: string[]; attemptLedger?: PhysicalRequestLedger } = {}) {
  const log = options.log ?? [];
  return createIntervalsIcuSource({ athleteId: "synthetic-athlete", historyOldestDate: options.oldest ?? "1998-01-01",
    historyNewestDate: options.newest ?? "1998-12-31", minRequestIntervalMs: 250,
    httpFactory: () => http, archive: options.archive ?? archive(log), wallClock: { now: () => Date.UTC(1998, 0, 1) },
    sleep: async () => {}, acl: {
      activity(row) { log.push("acl:activity"); return row; },
      streams(value) { log.push("acl:streams"); return Array.isArray(value)
        ? Object.fromEntries(value.map((entry) => [(entry as { type: string }).type, (entry as { data: unknown }).data])) : value as Record<string, unknown>; },
      assertClean() {},
    }, ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }) });
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []; for await (const value of iterable) result.push(value); return result;
}
const watermark = (lane: SourceWatermark["lane"], value: string | null = null): SourceWatermark => ({ source: "intervals-icu", lane, value });

describe("intervals.icu full-history source", () => {
  it("exposes exact capabilities", () => {
    const value = source({ fetch: async () => json([]) });
    expect(value.id).toBe("intervals-icu"); expect(value.capabilities).toEqual(INTERVALS_ICU_CAPABILITIES);
  });

  it("uses inclusive 365-date windows with no limit parameter", async () => {
    const requests: string[] = [];
    const value = source({ fetch: async (request) => { requests.push(request.url); return json([]); } },
      { oldest: "1998-01-01", newest: "1999-12-31" });
    const result = await collect(value.pull(watermark("activities"), budget()));
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!);
    expect([...url.searchParams]).toEqual([["oldest", "1998-01-01"], ["newest", "1998-12-31"]]);
    expect(url.searchParams.has("limit")).toBe(false);
    const cursor = JSON.parse((result.at(-1) as { watermark: { value: string } }).watermark.value);
    expect(cursor).toMatchObject({ window_start: "1999-01-01", window_end: "1999-12-31", complete: false });
  });

  it("supports mid-page resume and terminal refresh cycle", async () => {
    const http: HttpPort = { fetch: async () => json([activity("a"), activity("b", "1998-01-06")]) };
    const value = source(http);
    const first = await collect(value.pull(watermark("activities"), budget(1)));
    expect((first[0] as { externalId: string }).externalId).toBe("a");
    const firstCursor = (first[1] as { watermark: { value: string } }).watermark.value;
    const resumed = await collect(value.pull(watermark("activities", firstCursor), budget(1)));
    expect((resumed[0] as { externalId: string }).externalId).toBe("b");
    const terminal = compactCursor({ v: 1, cycle: 3, window_start: "1998-01-01", window_end: "1998-12-31", last_key: null, complete: true });
    const refreshed = await collect(value.pull(watermark("activities", terminal), budget(1)));
    expect(JSON.parse((refreshed.at(-1) as { watermark: { value: string } }).watermark.value).cycle).toBe(4);
  });

  it("pulls wellness days with decimal load averages in date order and resumes mid-page", async () => {
    const day = (id: string, fatigue: number | null) => ({ id, restingHR: 48, ctl: 31.2, atl: 27.787529, fatigue });
    const value = source({ fetch: async () => json([day("1998-01-06", 3), day("1998-01-05", null)]) });
    const first = await collect(value.pull(watermark("wellness"), budget(1)));
    expect(first[0]).toMatchObject({ kind: "snapshot", lane: "wellness", externalId: "1998-01-05",
      payload: day("1998-01-05", null), landing: { kind: "wellness", row: { date_key: 19980105, resting_hr: 48, fatigue: null } } });
    const cursor = (first[1] as { watermark: { value: string } }).watermark.value;
    const resumed = await collect(value.pull(watermark("wellness", cursor), budget(1)));
    expect(resumed[0]).toMatchObject({ externalId: "1998-01-06", landing: { kind: "wellness", row: { date_key: 19980106, fatigue: 3 } } });
  });

  it("stops the wellness pull at a day it cannot land, yields no day of that page, and names the field without its value", async () => {
    const value = source({ fetch: async () => json([{ id: "1998-01-05", restingHR: 48 }, { id: "1998-01-06", restingHR: -4471 }]) });
    const yielded: unknown[] = [];
    const drain = async (): Promise<null> => {
      for await (const item of value.pull(watermark("wellness"), budget())) yielded.push(item);
      return null;
    };
    const failure = await drain().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RowRejection);
    expect((failure as RowRejection).message).toBe("row rejected: landing of restingHR");
    expect(yielded).toEqual([]);
  });

  it("reports dropped rows once when resuming the same activity page", async () => {
    const page = [
      { id: "strava-stub", icu_athlete_id: "i12345", start_date_local: "1998-01-04T08:00:00", source: "STRAVA" },
      activity("a"),
      activity("b", "1998-01-06"),
    ];
    const value = source({ fetch: async () => json(page) });
    const first = await collect(value.pull(watermark("activities"), budget(1)));
    expect(first.at(-1)).toMatchObject({ kind: "checkpoint",
      droppedActivityRows: { sourceRestricted: 1, other: 0 } });
    const cursor = (first.at(-1) as { watermark: { value: string } }).watermark.value;

    const resumed = await collect(value.pull(watermark("activities", cursor), budget(1)));

    expect(resumed.at(-1)).toMatchObject({ kind: "checkpoint",
      droppedActivityRows: { sourceRestricted: 0, other: 0 } });
  });

  it.each([
    ["the next day", "1998-07-19", "1998-07-19"],
    ["five days later", "1998-07-23", "1998-07-23"],
    ["one year later", "1999-07-18", "1998-12-31"],
  ])("reopens a completed bulk history cursor %s", (_label, newest, expectedEnd) => {
    const producedRange = { oldest: "1998-01-01", newest: "1998-07-18" };
    const completed = advanceWindow(initialCursor("bulk-fit", producedRange), producedRange);

    expect(parseCursor(compactCursor(completed), "bulk-fit", { ...producedRange, newest })).toEqual({
      v: 1,
      cycle: 1,
      window_start: "1998-01-01",
      window_end: expectedEnd,
      last_key: null,
      complete: false,
      requestStart: "1998-07-18",
    });
  });

  it("re-fetches the completion day when reopening completed bulk history", async () => {
    const requests: string[] = [];
    const producedRange = { oldest: "1998-01-01", newest: "1998-07-18" };
    const completed = advanceWindow(initialCursor("bulk-fit", producedRange), producedRange);
    const value = source({ fetch: async (request) => {
      requests.push(request.url);
      return request.url.includes("/activities?")
        ? json([activity("boundary_ride", "1998-07-18")])
        : { status: 200, headers: { "content-type": "application/octet-stream" }, body: new Uint8Array([1]) };
    } },
      { ...producedRange, newest: "1998-07-23" });

    const result = await collect(value.pull(watermark("bulk-fit", compactCursor(completed)), budget()));

    expect(requests).toHaveLength(2);
    const url = new URL(requests[0]!);
    expect([...url.searchParams]).toEqual([["oldest", "1998-07-18"], ["newest", "1998-07-23"]]);
    expect(result).toContainEqual(expect.objectContaining({ kind: "raw-file", externalId: "boundary_ride" }));
    expect(JSON.parse((result.at(-1) as { watermark: { value: string } }).watermark.value)).toMatchObject({
      cycle: 1,
      window_start: "1998-01-01",
      window_end: "1998-07-23",
      complete: true,
    });
  });

  it("expands an interrupted final window after the date advances", () => {
    const interrupted = compactCursor({ v: 1, cycle: 0, window_start: "1998-01-01",
      window_end: "1998-07-18", last_key: "1998-07-18T07:00:00Z\u001fboundary", complete: false });

    expect(parseCursor(interrupted, "bulk-fit", { oldest: "1998-01-01", newest: "1998-07-23" })).toEqual({
      v: 1,
      cycle: 0,
      window_start: "1998-01-01",
      window_end: "1998-07-23",
      last_key: "1998-07-18T07:00:00Z\u001fboundary",
      complete: false,
    });
  });

  it("rejects a completed bulk history cursor with an off-lattice start", () => {
    const value = compactCursor({ v: 1, cycle: 0, window_start: "1998-01-02",
      window_end: "1998-07-18", last_key: null, complete: true });

    expect(() => parseCursor(value, "bulk-fit", { oldest: "1998-01-01", newest: "1998-07-19" })).toThrow(
      "source cursor range is invalid",
    );
  });

  it.each([
    ["ends before its start", "1998-07-20", "1998-07-19", "1998-07-19"],
    ["exceeds its 365-date window", "1998-01-01", "1999-01-01", "1999-01-02"],
    ["starts before the legal range", "1997-12-31", "1998-07-18", "1998-07-19"],
    ["ends after the legal range", "1998-07-18", "1998-07-20", "1998-07-19"],
  ])("rejects a completed bulk history cursor that %s", (_label, windowStart, windowEnd, newest) => {
    const value = compactCursor({ v: 1, cycle: 0, window_start: windowStart,
      window_end: windowEnd, last_key: null, complete: true });

    expect(() => parseCursor(value, "bulk-fit", { oldest: "1998-01-01", newest })).toThrow(
      "source cursor range is invalid",
    );
  });

  it("archives page and row before ACL and transport remains unchanged", async () => {
    const log: string[] = [], raw = activity("archive-order");
    const value = source({ fetch: async () => json([raw]) }, { log, archive: archive(log) });
    const iterator = value.pull(watermark("activities"), budget())[Symbol.asyncIterator]();
    const first = await iterator.next(); log.push("yield");
    expect(log).toEqual(["archive:page", "archive:row", "acl:activity", "yield"]);
    expect((first.value as { payload: unknown }).payload).toEqual(raw);
    expect((first.value as { landing: { platform: { activity: unknown } } }).landing.platform.activity).not.toBe(raw);
    await iterator.next();
  });

  it("attempts all activity streams with no live-bundle cap", async () => {
    const activities = Array.from({ length: 13 }, (_, index) => activity(`s${String(index).padStart(2, "0")}`, `1998-01-${String(index + 1).padStart(2, "0")}`));
    const requests: string[] = [];
    const http: HttpPort = { fetch: async (request) => {
      requests.push(request.url);
      return request.url.includes("/activities?") ? json(activities) : json([{ type: "time", data: [0] }, { type: "watts", data: [100] }]);
    } };
    const result = await collect(source(http).pull(watermark("streams"), budget(20, 20)));
    expect(result.filter((entry) => (entry as { kind: string }).kind === "snapshot")).toHaveLength(13);
    expect(requests.filter((url) => url.includes("streams.json"))).toHaveLength(13);
    const streamUrl = new URL(requests.find((url) => url.includes("streams.json"))!);
    expect(streamUrl.searchParams.getAll("types")).toEqual(["time", "watts", "heartrate", "dfa_a1", "artifacts"]);
    expect(streamUrl.searchParams.get("includeDefaults")).toBe("false");
  });

  it("checkpoints before another request or artifact would exceed the cap", async () => {
    const fetch = vi.fn(async () => json([activity("one"), activity("two", "1998-01-06")]));
    const result = await collect(source({ fetch }).pull(watermark("activities"), budget(1, 1)));
    expect(result.map((entry) => (entry as { kind: string }).kind)).toEqual(["snapshot", "checkpoint"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stores every visible activity when Strava stubs dominate the page", async () => {
    const stub = (index: number) => ({ id: `strava-${String(index).padStart(2, "0")}`, icu_athlete_id: "i12345",
      start_date_local: "1998-08-20T14:08:41", source: "STRAVA", _note: "STRAVA activities are not available via the API" });
    const visible = Array.from({ length: 7 }, (_, index) => activity(`visible-${index}`, `1998-03-0${index + 1}`));
    const page = [...Array.from({ length: 60 }, (_, index) => stub(index)), ...visible];

    const result = await collect(source({ fetch: async () => json(page) }).pull(watermark("activities"), budget()));

    const snapshots = result.filter((entry) => (entry as { kind: string }).kind === "snapshot");
    expect(snapshots).toHaveLength(7);
    expect(snapshots.map((entry) => (entry as { externalId: string }).externalId).sort())
      .toEqual(visible.map((entry) => entry.id).sort());
    expect(result.at(-1)).toMatchObject({ kind: "checkpoint" });
  });

  it("stores all 67 rows when the page carries no Strava stubs", async () => {
    const page = Array.from({ length: 67 }, (_, index) => activity(
      `full-${String(index).padStart(2, "0")}`,
      `1998-0${Math.floor(index / 28) + 1}-${String((index % 28) + 1).padStart(2, "0")}`,
    ));

    const result = await collect(source({ fetch: async () => json(page) }).pull(watermark("activities"), budget()));

    expect(result.filter((entry) => (entry as { kind: string }).kind === "snapshot")).toHaveLength(67);
  });

  it("counts 60 source-restricted drops and no other drops across a 67-row page", async () => {
    const stub = (index: number) => ({ id: `strava-${String(index).padStart(2, "0")}`, icu_athlete_id: "i12345",
      start_date_local: "1998-08-20T14:08:41", source: "STRAVA", _note: "STRAVA activities are not available via the API" });
    const visible = Array.from({ length: 7 }, (_, index) => activity(`visible-${index}`, `1998-03-0${index + 1}`));
    const page = [...Array.from({ length: 60 }, (_, index) => stub(index)), ...visible];

    const result = await collect(source({ fetch: async () => json(page) }).pull(watermark("activities"), budget()));

    expect(page).toHaveLength(67);
    expect(result.at(-1)).toMatchObject({ kind: "checkpoint",
      droppedActivityRows: { sourceRestricted: 60, other: 0 } });
  });

  it("counts a type-less row from another provider as an other drop", async () => {
    const page = [
      { id: "garmin-01", icu_athlete_id: "i12345", start_date_local: "1998-08-20T14:08:41", source: "GARMIN_CONNECT" },
      { id: "strava-01", icu_athlete_id: "i12345", start_date_local: "1998-08-20T14:08:41", source: "STRAVA" },
      activity("visible-0"),
    ];

    const result = await collect(source({ fetch: async () => json(page) }).pull(watermark("activities"), budget()));

    expect(result.at(-1)).toMatchObject({ kind: "checkpoint",
      droppedActivityRows: { sourceRestricted: 1, other: 1 } });
  });

  it("reports zero drops when the page carries no unusable rows", async () => {
    const page = Array.from({ length: 67 }, (_, index) => activity(
      `full-${String(index).padStart(2, "0")}`,
      `1998-0${Math.floor(index / 28) + 1}-${String((index % 28) + 1).padStart(2, "0")}`,
    ));

    const result = await collect(source({ fetch: async () => json(page) }).pull(watermark("activities"), budget()));

    expect(result.at(-1)).toMatchObject({ kind: "checkpoint",
      droppedActivityRows: { sourceRestricted: 0, other: 0 } });
  });

  it("carries the drop split on the bulk-fit checkpoint", async () => {
    const page = Array.from({ length: 60 }, (_, index) => ({ id: `strava-${String(index).padStart(2, "0")}`,
      icu_athlete_id: "i12345", start_date_local: "1998-08-20T14:08:41", source: "STRAVA" }));

    const result = await collect(source({ fetch: async () => json(page) }).pull(watermark("bulk-fit"), budget()));

    expect(result.at(-1)).toMatchObject({ kind: "checkpoint",
      droppedActivityRows: { sourceRestricted: 60, other: 0 } });
  });

  it("still rejects a typed activity row with an invalid elapsed time", async () => {
    const broken = { ...activity("broken"), elapsed_time: -1 };
    await expect(collect(source({ fetch: async () => json([broken]) }).pull(watermark("activities"), budget())))
      .rejects.toThrow("activity elapsed time is invalid");
  });

  it("charges the injected physical-attempt ledger at the actual source request", async () => {
    const attemptLedger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    await collect(source({ fetch: async () => json([]) }, { attemptLedger })
      .pull(watermark("activities"), budget()));
    expect(attemptLedger.snapshot()).toMatchObject({
      storeRequests: 1,
      legacyRequests: 0,
      totalRequests: 1,
      byTag: { "store:activities": 1 },
    });
  });
});
