import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { describe, expect, it } from "vitest";
import { runReferenceCapture } from "../src/capture.js";
import { readOneFtp } from "../src/one-ftp.js";
import { readAppliedFtps, readFtpEstimates, readIcuFtpVersions } from "../src/one-ftp-store.js";

const NOW = new Date("1998-07-18T12:00:00.000Z");

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ride(ftp: number, indoorFtp: number | null, updated: string) {
  return {
    sportSettings: [
      {
        id: 7,
        athlete_id: "synthetic-athlete",
        types: ["Ride", "VirtualRide"],
        updated,
        ftp,
        indoor_ftp: indoorFtp,
        lthr: 165,
        power_zones: [0, 125, 200, 250],
      },
    ],
  };
}

describe("one FTP from a real sync capture", () => {
  it("lands each new Ride settings version, millisecond update times included, and reads eFTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-ftp-capture-"));
    let profile = ride(250, null, "1998-07-01T08:12:34.567+00:00");
    const baseFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/streams.json")) return json({ time: [0, 1], watts: [200, 210] });
      if (url.includes("/activities?")) {
        return json([
          {
            id: 42,
            type: "Ride",
            start_date: "1998-07-17T10:00:00.000Z",
            start_date_local: "1998-07-17T12:00:00",
            moving_time: 3600,
            elapsed_time: 3700,
            distance: 40_000,
            icu_ftp: 265,
          },
        ]);
      }
      if (url.includes("/wellness?")) {
        return json([{ id: "1998-07-17", sportInfo: [{ type: "Ride", eftp: 262.4 }] }]);
      }
      return json(profile);
    };
    let monotonic = 0;
    const options = {
      env: { ENDURAGENT_HOME: root },
      apiKey: "synthetic-key",
      athleteId: "synthetic-athlete",
      calendarTimeZone: "UTC",
      reviewedOn: "1998-07-18",
      baseFetch,
    };
    const dependencies = {
      wallClock: () => NOW,
      monotonicNow: () => (monotonic += 250),
      sleep: async () => {},
    };
    const first = "12345678-1234-4123-8123-123456789abc";
    await runReferenceCapture(
      { ...options, reason: "initial" },
      { ...dependencies, uuid: () => first },
    );
    profile = ride(262, 255, "1998-07-17T19:02:00.001+00:00");
    await runReferenceCapture(
      { ...options, reason: "provider-refresh", replacesCaptureId: first },
      { ...dependencies, uuid: () => "87654321-4321-4321-8321-cba987654321" },
    );
    const store = openSqliteStorage(join(root, "store", "store.db"));
    try {
      expect(await readIcuFtpVersions(store, "synthetic-athlete")).toEqual([
        {
          updatedMs: Date.parse("1998-07-01T08:12:34.567+00:00"),
          ftpWatts: 250,
          indoorFtpWatts: null,
        },
        {
          updatedMs: Date.parse("1998-07-17T19:02:00.001+00:00"),
          ftpWatts: 262,
          indoorFtpWatts: 255,
        },
      ]);
      expect((await readOneFtp(store, "synthetic-athlete")).current).toMatchObject({
        watts: 262,
        source: "intervals",
      });
      expect(await readIcuFtpVersions(store, "another-athlete")).toEqual([]);
      expect(
        await readFtpEstimates(store, { startDateKey: 19980701, endDateKey: 19980718 }),
      ).toEqual([{ dateKey: 19980717, estimatedFtpWatts: 262 }]);
      expect(
        await store.get(
          "SELECT count(*) AS n FROM anchor_history WHERE anchor_type = 'ftp' AND source = 'intervals-icu'",
        ),
      ).toEqual({ n: 0 });
      const sessions = (await store.all("SELECT session_key FROM session")).map((row) =>
        String(row.session_key),
      );
      expect(sessions).toHaveLength(1);
      expect([...(await readAppliedFtps(store, sessions)).values()]).toEqual([265]);
    } finally {
      await store.close();
    }
  });
});
