import { createReferenceCapturePlan } from "@enduragent/kernel/reference/capture";
import type { SyncBudget } from "@enduragent/kernel/store";
import { describe, expect, it } from "vitest";
import { IntervalsHttpError } from "../src/http.js";
import { createIntervalsIcuSource } from "../src/source.js";

const NOW = new Date("1998-07-18T12:00:00.000Z");
const PLAN = createReferenceCapturePlan({ now: NOW, calendarTimeZone: "UTC" });
const PROFILE = {
  sportSettings: [
    {
      id: 7,
      athlete_id: "synthetic-athlete",
      types: ["Ride"],
      updated: "1998-07-01T00:00:00.000Z",
      ftp: 250,
    },
  ],
};
const RIDE = {
  type: "Ride",
  start_date: "1998-07-17T10:00:00.000Z",
  moving_time: 3600,
  elapsed_time: 3700,
  distance: 40_000,
};
const RIDES = [
  { ...RIDE, id: 42, start_date_local: "1998-07-17T12:00:00" },
  { ...RIDE, id: 43, start_date_local: "1998-07-16T12:00:00" },
];
const STREAMS = { time: [0, 1], watts: [200, 210] };

function response(value: unknown, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function budget(): SyncBudget {
  return {
    signal: new AbortController().signal,
    clock: { monotonicNow: () => 1 },
    deadlineMonotonicMs: 1_000,
    perRequestTimeoutMs: 1_000,
    maxRequests: 20,
    maxArtifacts: 20,
  };
}

function captureWithFirstStreamStatus(status: number) {
  const streamRequests: string[] = [];
  const source = createIntervalsIcuSource({
    athleteId: "synthetic-athlete",
    historyNewestDate: "1998-07-18",
    minRequestIntervalMs: 250,
    wallClock: { now: () => NOW.getTime() },
    sleep: async () => {},
    httpFactory: () => ({
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/streams.json")) {
          streamRequests.push(url.pathname);
          return streamRequests.length === 1 ? response({}, status) : response(STREAMS);
        }
        if (url.pathname.endsWith("/activities")) return response(RIDES);
        if (url.pathname.endsWith("/wellness")) return response([]);
        return response(PROFILE);
      },
    }),
    archive: {
      async writeSnapshot() {
        return {
          address: "0".repeat(64),
          relPath: `1998/07/${"0".repeat(64)}.json.gz`,
          deduped: false,
        };
      },
      async writeArtifact() {
        throw new Error("unused");
      },
      async quarantine() {
        throw new Error("unused");
      },
      async readArtifact() {
        throw new Error("unused");
      },
      async readSnapshot() {
        throw new Error("unused");
      },
      async has() {
        return false;
      },
    },
    acl: {
      activity: (row) => row,
      streams: (value) => value as Record<string, unknown>,
      assertClean() {},
    },
  });
  return { capture: source.captureReference(PLAN, budget()), streamRequests };
}

describe("captureReference when intervals.icu refuses a recording download", () => {
  it("ends the capture at the first 401 instead of counting the ride as unfetched", async () => {
    const { capture, streamRequests } = captureWithFirstStreamStatus(401);

    await expect(capture).rejects.toSatisfy(
      (error) => error instanceof IntervalsHttpError && error.status === 401,
    );
    expect(streamRequests).toEqual(["/api/v1/activity/42/streams.json"]);
  });

  it.each([403, 404])(
    "lists a recording that answered %i as unfetched and keeps the other rides",
    async (status) => {
      const { capture } = captureWithFirstStreamStatus(status);
      const batch = await capture;

      expect(batch.captured_stream_ids).toEqual(["43"]);
      expect(batch.report.streams.unfetched).toEqual([
        expect.objectContaining({ externalId: "streams:42", field: `http_${status}` }),
      ]);
    },
  );
});
