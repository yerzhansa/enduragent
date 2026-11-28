import { describe, expect, it, onTestFinished } from "vitest";
import {
  createPlanRepository,
  createPlanWorkoutMatchRepository,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { landWellnessRow, mapSettingsLanding } from "@enduragent/sync-intervals-icu";
import {
  landIcuStreams,
  rideSettingsWire,
} from "../../../apps/desktop/tests/helpers/icu-ftp-fake.js";
import { ftpOwner } from "../src/one-ftp.js";
import { createOneFtpAnchorResolver } from "../src/one-ftp-anchor.js";
import { createOneFtpPlanAdapter } from "../src/one-ftp-plan.js";
import { readFtpEstimates, readIcuFtpVersions } from "../src/one-ftp-store.js";
import { createStoredFtpTestResults } from "../src/one-ftp-tests.js";
import { addCivilDays } from "@enduragent/kernel/planning";
import { storeOwnerFingerprint } from "../src/account-identity.js";
import { ATHLETE, RIDE, SET_DAY, ftpHarness, msOf, seedRide } from "./one-ftp-harness.js";

const atSeconds = (dateKey: number, time = "12:00:00.000") =>
  Math.floor(msOf(dateKey, time) / 1_000);

describe("one FTP: reading intervals.icu", () => {
  it("reads the ride FTP and eFTP that sync stored, and never dates the first synced FTP", async () => {
    const test = await ftpHarness({ ...RIDE, indoorFtp: 274 });
    await test.estimates(3, 276);
    const read = await test.read();
    expect(read.current).toEqual({ watts: 282, dateKey: SET_DAY, source: "first-sync" });
    expect(read.history).toEqual([{ watts: 282, dateKey: SET_DAY, source: "first-sync" }]);
    expect(read.estimates.at(-1)).toEqual({ dateKey: 19980819, watts: 276 });
    expect(read.chart).toEqual({
      startDateKey: addCivilDays(19980819, -179),
      endDateKey: 19980819,
      steps: [{ dateKey: addCivilDays(19980819, -179), watts: 282, source: "first-sync" }],
    });
    expect(read.proposal).toEqual({ kind: "none" });
  });

  it("starts the first synced FTP at the chart's start and dates only later changes", async () => {
    const test = await ftpHarness({ ...RIDE, ftp: 268, updated: "1998-06-20T08:00:00.120+00:00" });
    await test.land({ ...RIDE, ftp: 282, updated: "1998-08-01T08:00:00.120+00:00" });
    const read = await test.read();
    expect(read.chart.steps).toEqual([
      { dateKey: read.chart.startDateKey, watts: 268, source: "first-sync" },
      { dateKey: 19980801, watts: 282, source: "intervals" },
    ]);
  });

  it("reads what the sync lands, including intervals.icu's millisecond update times", async () => {
    const test = await ftpHarness();
    const wire = rideSettingsWire({
      id: 78,
      ftp: 290,
      indoorFtp: 280,
      updated: "1998-08-01T10:00:00.250+00:00",
    });
    expect((await mapSettingsLanding(wire)).anchors).toEqual([]);
    const wellness = await landWellnessRow({
      id: "1998-08-02",
      sportInfo: [{ type: "Ride", eftp: 291.4, wPrime: 18_000, pMax: 900 }],
    });
    await test.store.run(
      "INSERT INTO wellness (id,date_key,provenance,source,fields_json) VALUES (?,?,?,?,?)",
      [wellness.row.id, wellness.row.date_key, "sync", "intervals-icu", wellness.row.fields_json],
    );
    expect(
      await readFtpEstimates(test.store, { startDateKey: 19980801, endDateKey: 19980803 }),
    ).toEqual([{ dateKey: 19980802, estimatedFtpWatts: 291 }]);
    await test.land({ id: 78, ftp: 290, indoorFtp: 280, updated: "1998-08-01T10:00:00.250+00:00" });
    expect(
      (await readIcuFtpVersions(test.store, ATHLETE)).map((version) => version.ftpWatts),
    ).toEqual([282, 290]);
  });

  it("adds a line set by you when the FTP changes in intervals.icu between syncs", async () => {
    const test = await ftpHarness();
    await test.land({ ...RIDE, ftp: 285, updated: "1998-08-18T18:02:00.001+00:00" });
    await test.land({ ...RIDE, ftp: 285, updated: "1998-08-18T19:00:00.001+00:00" });
    const read = await test.read();
    expect(read.history).toEqual([
      { watts: 282, dateKey: SET_DAY, source: "first-sync" },
      { watts: 285, dateKey: 19980818, source: "intervals" },
    ]);
    expect(read.current?.watts).toBe(285);
  });

  it("reads only the connected athlete's intervals.icu settings", async () => {
    const test = await ftpHarness();
    await test.land({
      ...RIDE,
      ftp: 400,
      updated: "1998-08-18T18:02:00.001+00:00",
      athleteId: "i1999",
    });
    expect((await test.read()).current?.watts).toBe(282);
    expect(await readIcuFtpVersions(test.store, "i1999")).toEqual([
      expect.objectContaining({ ftpWatts: 400 }),
    ]);
  });

  it("reads the FTP of the athlete the store belongs to, however Settings spells the ID", async () => {
    const spelled = await ftpHarness(RIDE, { athleteId: " I1998" });
    expect((await spelled.read()).current?.watts).toBe(282);
    const owned = await ftpHarness(RIDE, { athleteId: "someone-else" });
    await owned.land({
      ...RIDE,
      ftp: 400,
      updated: "1998-08-18T18:02:00.001+00:00",
      athleteId: "i1999",
    });
    await owned.store.run(
      "INSERT INTO store_owner (singleton, account_fingerprint) VALUES (1, ?)",
      [storeOwnerFingerprint(ATHLETE)],
    );
    expect((await owned.read()).current?.watts).toBe(282);
    await expect(ftpOwner(owned.store, "i1999")).resolves.toBe(ATHLETE);
  });

  it("shows no FTP rather than another account's when the store cannot tell whose it is", async () => {
    const test = await ftpHarness(RIDE, { athleteId: " I1998" });
    await test.land({
      ...RIDE,
      id: 91,
      ftp: 240,
      updated: "1998-08-10T08:00:00.120+00:00",
      athleteId: "i1999",
    });
    expect((await test.read()).history.map((line) => line.watts)).toEqual([282]);
    for (const configured of ["0", "1998", "someone-else", null]) {
      test.setAthlete(configured);
      const read = await test.read();
      expect([read.current, read.history, read.proposal]).toEqual([null, [], { kind: "none" }]);
      await expect(ftpOwner(test.store, configured)).resolves.toBeNull();
    }
    await test.store.run("INSERT INTO store_owner (singleton, account_fingerprint) VALUES (1, ?)", [
      storeOwnerFingerprint("i2000"),
    ]);
    test.setAthlete(ATHLETE);
    expect((await test.read()).current).toBeNull();
    const empty = await ftpHarness(null);
    await expect(ftpOwner(empty.store, "i1998")).resolves.toBeNull();
  });

  it("gives the coach intervals.icu's FTP in effect, and ignores a local correction", async () => {
    const test = await ftpHarness();
    await test.land({ ...RIDE, ftp: 285, updated: "1998-08-01T08:00:00.100+00:00" });
    await test.store.run(
      "INSERT INTO anchor_history (id,sport,anchor_type,value,unit,valid_from,source,confidence,note,provenance,device_id,hlc_physical_ms,hlc_counter) VALUES ('01J00000000000000000000001','cycling','ftp',290,'W',?,'athlete','manual',NULL,'manual','d',1,0)",
      [atSeconds(19980810)],
    );
    const resolver = createOneFtpAnchorResolver(test.store, () => ATHLETE);
    const at = atSeconds(19980819);
    await expect(
      resolver.resolve({ effectiveAtEpochS: at, evaluatedAtEpochS: at }),
    ).resolves.toMatchObject({
      kind: "ftp",
      watts: 285,
      validFrom: "1998-08-01",
      source: "intervals-icu",
      stalenessBand: "fresh",
    });
    const before = atSeconds(19980701);
    await expect(
      resolver.resolve({ effectiveAtEpochS: before, evaluatedAtEpochS: at }),
    ).resolves.toEqual({ kind: "missing", refusal: "missing-cycling-ftp-anchor" });
    const plan = createOneFtpPlanAdapter({
      store: test.store,
      athleteId: () => ATHLETE,
      repository: { insertIfAbsent: async () => true },
      identity: {
        newUlid: () => "01J00000000000000000000002",
        deviceId: async () => "d",
        hlcStamp: () => ({ physicalMs: 1, counter: 0 }),
      },
      readLatest: () => ({
        metadata: { last_updated: "1998-08-19T06:00:00.000Z" },
        derived_metrics: { eftp: 276 },
      }),
      refreshIntervals: async () => undefined,
    });
    await expect(plan.read()).resolves.toMatchObject({
      usedSource: "intervals-ftp",
      usedWatts: 285,
      conflict: false,
    });
  });

  it("dates a first synced FTP from the rides intervals.icu rated with it, never from its update time", async () => {
    const test = await ftpHarness();
    const resolver = createOneFtpAnchorResolver(test.store, () => ATHLETE);
    const at = atSeconds(19980819);
    await expect(
      resolver.resolve({ effectiveAtEpochS: at, evaluatedAtEpochS: at }),
    ).resolves.toEqual({
      kind: "ftp",
      watts: 282,
      validFrom: "1998-08-19",
      source: "intervals-icu",
      confidence: "platform",
      ageDays: 0,
      stalenessBand: "stale",
      stale: true,
    });
    await seedRide(test.store, { key: "a".repeat(64), startMs: msOf(19980301), icuFtp: 270 });
    await seedRide(test.store, { key: "b".repeat(64), startMs: msOf(19980402), icuFtp: 282 });
    await seedRide(test.store, { key: "c".repeat(64), startMs: msOf(19980610) });
    await seedRide(test.store, {
      key: "e".repeat(64),
      startMs: msOf(19980615),
      icuFtp: 266,
      subSport: "indoor_cycling",
    });
    await seedRide(test.store, { key: "d".repeat(64), startMs: msOf(19980805), icuFtp: 282 });
    await expect(
      resolver.resolve({ effectiveAtEpochS: at, evaluatedAtEpochS: at }),
    ).resolves.toMatchObject({
      watts: 282,
      validFrom: "1998-04-02",
      stalenessBand: "stale",
    });
  });

  it("clears the coach's FTP when the athlete clears it in intervals.icu", async () => {
    const test = await ftpHarness();
    await test.land({ ...RIDE, ftp: null, updated: "1998-08-01T08:00:00.100+00:00" });
    const resolver = createOneFtpAnchorResolver(test.store, () => ATHLETE);
    const at = atSeconds(19980819);
    await expect(
      resolver.resolve({ effectiveAtEpochS: at, evaluatedAtEpochS: at }),
    ).resolves.toEqual({
      kind: "missing",
      refusal: "missing-cycling-ftp-anchor",
    });
    expect((await test.read()).current).toBeNull();
  });
});

describe("one FTP: when the coach proposes", () => {
  it("proposes 1% under the lowest estimate after 14 days at least 3% above FTP", async () => {
    const test = await ftpHarness();
    await test.estimates(14, 291);
    await test.sync();
    expect((await test.read()).proposal).toEqual({
      kind: "shown",
      watts: 288,
      shownOnDateKey: 19980819,
      percent: 2,
      basis: {
        kind: "drift",
        direction: "above",
        sinceDateKey: 19980806,
        lowWatts: 291,
        highWatts: 291,
        lowestWatts: 291,
      },
    });
  });

  it("waits through 13 days and never proposes from one ride", async () => {
    const test = await ftpHarness();
    await test.estimates(13, 291);
    await test.sync();
    expect((await test.read()).proposal).toEqual({ kind: "none" });
    const single = await ftpHarness();
    await single.estimates(1, 320);
    await single.sync();
    expect((await single.read()).proposal).toEqual({ kind: "none" });
  });

  it("answers a planned FTP test, even within four weeks of Keep", async () => {
    const test = await ftpHarness();
    await test.estimates(14, 291);
    await test.sync();
    expect((await test.read()).proposal).toMatchObject({ kind: "shown", watts: 288 });
    const kept = await test.answer("keep", { kind: "shown", watts: 288 });
    expect([kept.outcome, kept.proposal]).toEqual(["none", { kind: "none" }]);
    test.setToday(addCivilDays(19980819, 10));
    await test.estimates(10, 292);
    await test.sync();
    expect((await test.read()).proposal).toEqual({ kind: "none" });
    test.setTests([{ activityId: "a".repeat(64), dateKey: 19980828, twentyMinuteWatts: 303 }]);
    await test.sync();
    expect((await test.read()).proposal).toMatchObject({
      kind: "shown",
      watts: 288,
      basis: { kind: "planned-test", testDateKey: 19980828, bestWatts: 303 },
    });
  });

  it("raises the estimate again only after the four weeks Keep waits", async () => {
    const test = await ftpHarness();
    await test.estimates(14, 291);
    await test.sync();
    await test.read();
    expect((await test.answer("keep", { kind: "shown", watts: 288 })).outcome).toBe("none");
    test.setToday(addCivilDays(19980819, 27));
    await test.estimates(28, 291);
    await test.sync();
    expect((await test.read()).proposal).toEqual({ kind: "none" });
    test.setToday(addCivilDays(19980819, 28));
    await test.estimates(29, 291);
    await test.sync();
    expect((await test.read()).proposal).toMatchObject({ kind: "shown", watts: 288 });
  });

  it("retires a drift card when the athlete sets a new FTP in intervals.icu", async () => {
    const test = await ftpHarness();
    await test.estimates(14, 291);
    await test.sync();
    expect((await test.read()).proposal).toMatchObject({ kind: "shown" });
    await test.land({ ...RIDE, ftp: 295, updated: "1998-08-19T09:00:00.001+00:00" });
    await test.sync();
    const after = await test.read();
    expect(after.current?.watts).toBe(295);
    expect(after.proposal).toEqual({ kind: "none" });
  });

  it("does not propose a planned test the athlete already acted on, or the FTP they hold", async () => {
    const test = await ftpHarness();
    test.setTests([{ activityId: "b".repeat(64), dateKey: 19980817, twentyMinuteWatts: 297 }]);
    await test.land({ ...RIDE, ftp: 283, updated: "1998-08-18T20:00:00.001+00:00" });
    await test.sync();
    expect((await test.read()).proposal).toEqual({ kind: "none" });
    const same = await ftpHarness();
    same.setTests([{ activityId: "c".repeat(64), dateKey: 19980818, twentyMinuteWatts: 297 }]);
    await same.sync();
    expect((await same.read()).proposal).toEqual({ kind: "none" });
  });

  it("compares a planned test with the time the FTP was set, not its day", async () => {
    const test = await ftpHarness();
    test.setTests([
      {
        activityId: "e".repeat(64),
        dateKey: 19980819,
        startMs: msOf(19980819, "10:00:00.000"),
        twentyMinuteWatts: 310,
      },
    ]);
    await test.land({ ...RIDE, ftp: 284, updated: "1998-08-19T06:00:00.001+00:00" });
    await test.sync();
    expect((await test.read()).proposal).toMatchObject({
      kind: "shown",
      watts: 295,
      basis: { kind: "planned-test", testDateKey: 19980819 },
    });
    const before = await ftpHarness();
    before.setTests([
      {
        activityId: "f".repeat(64),
        dateKey: 19980819,
        startMs: msOf(19980819, "05:00:00.000"),
        twentyMinuteWatts: 310,
      },
    ]);
    await before.land({ ...RIDE, ftp: 284, updated: "1998-08-19T06:00:00.001+00:00" });
    await before.sync();
    expect((await before.read()).proposal).toEqual({ kind: "none" });
  });

  it("counts a planned test ridden after the first synced FTP's time on the same day", async () => {
    const firstSync = { ...RIDE, updated: "1998-08-19T06:00:00.001+00:00" };
    const later = await ftpHarness(firstSync);
    later.setTests([
      {
        activityId: "g".repeat(64),
        dateKey: 19980819,
        startMs: msOf(19980819, "10:00:00.000"),
        twentyMinuteWatts: 310,
      },
    ]);
    await later.sync();
    expect((await later.read()).proposal).toMatchObject({ kind: "shown", watts: 295 });
    const earlier = await ftpHarness(firstSync);
    earlier.setTests([
      {
        activityId: "h".repeat(64),
        dateKey: 19980819,
        startMs: msOf(19980819, "05:00:00.000"),
        twentyMinuteWatts: 310,
      },
    ]);
    await earlier.sync();
    expect((await earlier.read()).proposal).toEqual({ kind: "none" });
  });

  it("makes no proposal without Ride settings in intervals.icu", async () => {
    const test = await ftpHarness(null);
    await test.estimates(14, 291);
    test.setTests([{ activityId: "d".repeat(64), dateKey: 19980818, twentyMinuteWatts: 303 }]);
    await test.sync();
    const read = await test.read();
    expect(read.current).toBeNull();
    expect(read.proposal).toEqual({ kind: "none" });
  });
});

describe("one FTP: a planned FTP test", () => {
  it("reads 95% of the best 20 minutes of a ride confirmed to a planned FTP test", async () => {
    const store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    onTestFinished(async () => {
      await store.close();
    });
    const planId = `${"0".repeat(25)}P`;
    const workout = (index: number, name: string) => ({
      id: `${"0".repeat(24)}${10 + index}`,
      planId,
      dateKey: 19980817 + index,
      sport: "Ride",
      name,
      durationS: 3_600,
      structureJson: "{}",
      origin: "coach" as const,
      deviceId: "test-device",
      hlcPhysicalMs: 1,
      hlcCounter: 0,
    });
    await createPlanRepository(store).replace(
      {
        id: planId,
        originId: null,
        name: "Synthetic build",
        primaryGoal: "Ride stronger",
        startDateKey: 19980810,
        targetDateKey: null,
        status: "active",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 1,
        updatedAtMs: 1,
        deviceId: "test-device",
        hlcPhysicalMs: 1,
        hlcCounter: 0,
      },
      [workout(1, "20-minute FTP test"), workout(2, "Threshold 4×8")],
    );
    await store.run(
      `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
       VALUES (?,'active',1,1,1,1,'test-device',1,0)`,
      [planId],
    );
    const matches = createPlanWorkoutMatchRepository(store);
    for (const [index, provider] of [
      [1, "i777"],
      [2, "i778"],
    ] as const) {
      await matches.observe({
        id: `${"0".repeat(24)}M${index}`,
        planId,
        planWorkoutId: workout(index, "").id,
        activityId: String(index).repeat(64),
        providerActivityId: provider,
        providerEventId: null,
        source: "heuristic",
        decision: "confirmed",
        activityDateKey: 19980817 + index,
        activitySport: "cycling",
        activityDurationS: 3_600,
        observedAtMs: 1,
        decidedAtMs: 1,
        deviceId: "test-device",
        hlcPhysicalMs: 1,
        hlcCounter: 0,
      });
    }
    const time = Array.from({ length: 1_800 }, (_, second) => second);
    await landIcuStreams(store, "i777", {
      time,
      watts: time.map((second) => (second < 300 ? 150 : 303)),
    });
    await landIcuStreams(store, "i778", { time, watts: time.map(() => 320) });
    await seedRide(store, { key: "1".repeat(64), startMs: msOf(19980818, "07:30:00.000") });
    await seedRide(store, { key: "2".repeat(64), startMs: msOf(19980819, "07:30:00.000") });
    await expect(createStoredFtpTestResults(store).read()).resolves.toEqual([
      {
        activityId: "1".repeat(64),
        dateKey: 19980818,
        startMs: msOf(19980818, "07:30:00.000"),
        twentyMinuteWatts: 303,
      },
    ]);
  });
});
