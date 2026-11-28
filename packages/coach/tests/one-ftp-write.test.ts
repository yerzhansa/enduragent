import { describe, expect, it } from "vitest";
import { IntervalsClient } from "intervals-icu-api";
import { FAKE_SETTINGS_EXTRA } from "../../../apps/desktop/tests/helpers/icu-ftp-fake.js";
import { createIcuSportSettingsPort } from "../src/one-ftp-icu.js";
import { RIDE, ftpHarness, msOf } from "./one-ftp-harness.js";

async function confirming() {
  const test = await ftpHarness();
  await test.estimates(14, 291);
  await test.sync();
  await test.read();
  const used = await test.answer("use", { kind: "shown", watts: 288 });
  expect(used.proposal).toMatchObject({
    kind: "confirming",
    watts: 288,
    icuWatts: 282,
    changedSinceUse: false,
    icuChangedAtMs: null,
    percent: 2,
    workoutsOnIntervals: 0,
  });
  return test;
}

describe("one FTP: the confirm and the write", () => {
  it("writes the whole Ride record with the new FTP after the confirm, and adds the coach's line", async () => {
    const test = await confirming();
    const written = await test.answer("confirm", { kind: "confirming", watts: 288 });
    expect(written.outcome).toBe("written");
    expect(test.icu.writes).toHaveLength(1);
    expect(test.icu.writes[0]?.body).toEqual({
      ...FAKE_SETTINGS_EXTRA,
      athlete_id: "i1998",
      types: ["Ride", "VirtualRide", "GravelRide"],
      indoor_ftp: null,
      updated: RIDE.updated,
      ftp: 288,
    });
    expect(written.proposal).toEqual({ kind: "none" });
    expect(written.current).toEqual({ watts: 288, dateKey: 19980819, source: "coach-estimate" });
    await test.land(test.icu.settings);
    expect((await test.read()).history.map((line) => [line.watts, line.source])).toEqual([
      [282, "first-sync"],
      [288, "coach-estimate"],
    ]);
  });

  it("shows the new number first when the FTP changed in intervals.icu since Use, and Keep writes nothing", async () => {
    const test = await confirming();
    test.icu.settings = { ...RIDE, ftp: 285, updated: "1998-08-19T18:02:00.000+00:00" };
    const changed = await test.answer("confirm", { kind: "confirming", watts: 288 });
    expect(changed.outcome).toBe("changed");
    expect(changed.proposal).toMatchObject({
      kind: "confirming",
      icuWatts: 285,
      changedSinceUse: true,
      icuChangedAtMs: Date.parse("1998-08-19T18:02:00.000+00:00"),
      percent: 1,
    });
    expect(test.icu.writes).toEqual([]);
    const kept = await test.answer("keep", { kind: "confirming", watts: 288 });
    expect([kept.outcome, kept.proposal]).toEqual(["none", { kind: "none" }]);
    expect(test.icu.writes).toEqual([]);
    expect(await test.store.all("SELECT * FROM ftp_accepted")).toEqual([]);
  });

  it("writes after the athlete chooses Set instead on the changed number", async () => {
    const test = await confirming();
    test.icu.settings = { ...RIDE, ftp: 285, updated: "1998-08-19T18:02:00.000+00:00" };
    await test.answer("confirm", { kind: "confirming", watts: 288 });
    const written = await test.answer("confirm", { kind: "confirming", watts: 288 });
    expect(written.outcome).toBe("written");
    expect(test.icu.writes.map((write) => write.watts)).toEqual([288]);
  });

  it("refuses to write when the FTP changes between the reread and the write", async () => {
    const test = await confirming();
    test.icu.onRead = (count) => {
      if (count === 3)
        test.icu.settings = { ...RIDE, ftp: 286, updated: "1998-08-19T18:03:00.000+00:00" };
    };
    const refused = await test.answer("confirm", { kind: "confirming", watts: 288 });
    expect(refused.outcome).toBe("changed");
    expect(refused.proposal).toMatchObject({ kind: "confirming", icuWatts: 286 });
    expect(test.icu.writes).toEqual([]);
  });

  it("changes nothing when intervals.icu does not answer, and says so", async () => {
    const test = await confirming();
    test.icu.failWrites = 1;
    const failed = await test.answer("confirm", { kind: "confirming", watts: 288 });
    expect(failed.outcome).toBe("unavailable");
    expect(failed.current).toMatchObject({ watts: 282, source: "first-sync" });
    expect(failed.proposal).toMatchObject({ kind: "shown", watts: 288 });
    expect(await test.store.all("SELECT * FROM ftp_accepted")).toEqual([]);
    test.icu.failReads = 1;
    const unread = await test.answer("use", { kind: "shown", watts: 288 });
    expect(unread.outcome).toBe("unavailable");
    expect(unread.proposal).toMatchObject({ kind: "shown" });
  });

  it("rereads after a lost answer and records the write intervals.icu kept", async () => {
    const test = await confirming();
    test.icu.loseWriteAnswers = 1;
    const written = await test.answer("confirm", { kind: "confirming", watts: 288 });
    expect(written.outcome).toBe("written");
    expect(written.current).toMatchObject({ watts: 288, source: "coach-estimate" });
    expect(await test.store.all("SELECT watts, icu_updated_ms FROM ftp_accepted")).toEqual([
      { watts: 288, icu_updated_ms: msOf(19980819) },
    ]);
  });

  it("finishes quietly when the athlete already set the number in intervals.icu", async () => {
    const test = await confirming();
    const athleteSet = { ...RIDE, ftp: 288, updated: "1998-08-19T09:30:00.001+00:00" };
    test.icu.settings = athleteSet;
    await test.land(athleteSet);
    const done = await test.answer("confirm", { kind: "confirming", watts: 288 });
    expect([done.outcome, done.proposal]).toEqual(["none", { kind: "none" }]);
    expect(test.icu.writes).toEqual([]);
    expect(await test.store.all("SELECT * FROM ftp_accepted")).toEqual([]);
    expect(done.history.at(-1)).toMatchObject({ watts: 288, source: "intervals" });
  });

  it("records the coach's FTP for the store's athlete when the record names none, and never an empty one", async () => {
    const test = await confirming();
    test.icu.settings = { ...test.icu.settings, athleteId: "" };
    expect((await test.answer("confirm", { kind: "confirming", watts: 288 })).outcome).toBe(
      "written",
    );
    expect(await test.store.all("SELECT athlete_id FROM ftp_accepted")).toEqual([
      { athlete_id: "i1998" },
    ]);
    await expect(
      test.store.run(
        "INSERT INTO ftp_accepted (id,athlete_id,watts,previous_watts,basis,set_at_ms,icu_updated_ms,written_at_ms) VALUES ('01J00000000000000000000077','',288,282,'drift',1,1,1)",
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it.each(["use", "confirm"] as const)(
    "stores the same quiet state, with the test answered, when intervals.icu already holds the number at %s",
    async (answer) => {
      const test = await ftpHarness();
      test.setTests([{ activityId: "t".repeat(64), dateKey: 19980818, twentyMinuteWatts: 303 }]);
      await test.sync();
      expect((await test.read()).proposal).toMatchObject({ kind: "shown", watts: 288 });
      if (answer === "confirm") await test.answer("use", { kind: "shown", watts: 288 });
      test.icu.settings = { ...RIDE, ftp: 288, updated: "1998-08-19T09:30:00.001+00:00" };
      const done = await test.answer(answer, {
        kind: answer === "use" ? "shown" : "confirming",
        watts: 288,
      });
      expect([done.outcome, done.proposal, test.icu.writes]).toEqual([
        "none",
        { kind: "none" },
        [],
      ]);
      const state = await test.store.get("SELECT state_json FROM ftp_proposal_state WHERE id=1");
      expect(JSON.parse(String(state?.state_json))).toEqual({
        athleteId: "i1998",
        proposal: {
          kind: "quiet",
          memory: {
            pause: { kind: "none" },
            answeredTest: { kind: "answered", activityId: "t".repeat(64), dateKey: 19980818 },
            ftpSeen: { kind: "seen", watts: 282, sinceDateKey: 19980819 },
          },
        },
        shownOnDateKey: null,
        usedIcuWatts: null,
        icuChangedAtMs: null,
      });
    },
  );

  it("keeps one athlete's accepted FTP and proposal memory out of another account", async () => {
    const test = await confirming();
    expect((await test.answer("confirm", { kind: "confirming", watts: 288 })).outcome).toBe(
      "written",
    );
    expect(await test.store.all("SELECT athlete_id, watts FROM ftp_accepted")).toEqual([
      { athlete_id: "i1998", watts: 288 },
    ]);
    await test.land({
      ...RIDE,
      ftp: 300,
      updated: "1998-08-10T08:00:00.100+00:00",
      athleteId: "i1999",
    });
    test.setAthlete("i1999");
    const other = await test.read();
    expect(other.current).toMatchObject({ watts: 300, source: "first-sync" });
    expect(other.history.map((line) => line.watts)).toEqual([300]);
    expect(other.proposal).toEqual({ kind: "none" });
    const state = await test.store.get("SELECT state_json FROM ftp_proposal_state WHERE id=1");
    expect(JSON.parse(String(state?.state_json))).toMatchObject({
      athleteId: "i1999",
      proposal: { memory: { ftpSeen: { kind: "seen", watts: 300 } } },
    });
  });

  it("sends one write when two confirms arrive at once", async () => {
    const test = await confirming();
    const [first, second] = await Promise.all([
      test.answer("confirm", { kind: "confirming", watts: 288 }),
      test.answer("confirm", { kind: "confirming", watts: 288 }),
    ]);
    expect([first.outcome, second.outcome]).toEqual(["written", "refused"]);
    expect(test.icu.writes).toHaveLength(1);
  });

  it("goes back to the card on Cancel and refuses an answer to a card that changed", async () => {
    const test = await confirming();
    expect((await test.answer("confirm", { kind: "shown", watts: 288 })).outcome).toBe("refused");
    const cancelled = await test.answer("cancel", { kind: "confirming", watts: 288 });
    expect(cancelled.proposal).toMatchObject({ kind: "shown", watts: 288 });
    expect(test.icu.writes).toEqual([]);
  });
});

describe("one FTP: the intervals.icu sport settings endpoint", () => {
  it("rereads the Ride record and puts it back whole with only the FTP changed, never applying it to past rides", async () => {
    const captured = {
      id: 77,
      athlete_id: "i1998",
      types: ["Ride", "VirtualRide"],
      ftp: 282,
      indoor_ftp: 274,
      lthr: 168,
      max_hr: 188,
      w_prime: 18_500,
      power_zones: [55, 75, 90, 105, 120, 150, 999],
      hr_zones: [137, 153, 160, 168, 172, 177, 188],
      updated: "1998-08-19T12:00:00.123+00:00",
      sft_ftp: 280,
      sft_type: "RAMP",
      eFTPSupported: true,
      cho_used_calc: "MODEL",
      p30s_exponent: 0.9,
    };
    const requests: { method: string; url: string; body: unknown }[] = [];
    const client = new IntervalsClient({
      apiKey: "synthetic-key",
      athleteId: "i1998",
      retry: { maxAttempts: 1 },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          method: request.method,
          url: request.url,
          body: request.method === "GET" ? null : JSON.parse(await request.text()),
        });
        return new Response(JSON.stringify(captured), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const port = createIcuSportSettingsPort(() => client);
    const settings = await port.readRide();
    expect(settings).toMatchObject({
      settingsId: 77,
      ftpWatts: 282,
      indoorFtpWatts: 274,
      updatedMs: Date.parse("1998-08-19T12:00:00.123+00:00"),
    });
    await port.writeRideFtp({ settings, watts: 288 });
    const { id, ...withoutId } = captured;
    expect(id).toBe(77);
    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://intervals.icu/api/v1/athlete/i1998/sport-settings/Ride",
        body: null,
      },
      {
        method: "PUT",
        url: "https://intervals.icu/api/v1/athlete/i1998/sport-settings/77?recalcHrZones=false",
        body: { ...withoutId, ftp: 288 },
      },
    ]);
    expect(requests.some((request) => request.url.includes("/apply"))).toBe(false);
  });
});
