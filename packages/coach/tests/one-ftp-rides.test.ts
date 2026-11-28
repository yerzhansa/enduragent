import { describe, expect, it } from "vitest";
import type { PlanCalendarRide } from "@enduragent/coach-contract";
import { addCivilDays } from "@enduragent/kernel/planning";
import {
  ATHLETE,
  RIDE,
  dateKeyOf,
  ftpHarness,
  msOf,
  seedRide,
  type FtpHarness,
} from "./one-ftp-harness.js";

async function rides(
  test: FtpHarness,
  endDateKey = 19980819,
): Promise<ReadonlyMap<string, PlanCalendarRide["ftp"]>> {
  const result = await test.call({
    action: "rides",
    startDateKey: addCivilDays(endDateKey, -119),
    endDateKey,
  });
  if (result.status !== "rides") throw new TypeError(`unexpected ${result.status}`);
  return new Map(result.rides.map((ride) => [ride.activityId, ride.ftp]));
}

describe("one FTP on each ride", () => {
  it("keeps a ride from this morning on the FTP it used after a new FTP is set this evening", async () => {
    const test = await ftpHarness({ ...RIDE, updated: "1998-02-09T08:00:00.100+00:00" });
    test.setToday(19980301);
    await test.estimates(14, 297, 19980301);
    await test.land({ ...RIDE, ftp: 282, updated: "1998-02-15T08:00:00.100+00:00" });
    await seedRide(test.store, { key: "a".repeat(64), startMs: msOf(19980301, "07:00:00.000") });
    await test.sync();
    const shown = await test.read();
    expect(shown.proposal).toMatchObject({ kind: "shown", watts: 294 });
    test.setNow(msOf(19980301, "18:00:00.000"));
    await test.answer("use", { kind: "shown", watts: 294 });
    expect((await test.answer("confirm", { kind: "confirming", watts: 294 })).outcome).toBe(
      "written",
    );
    expect((await rides(test, 19980301)).get("a".repeat(64))).toEqual({
      kind: "known",
      watts: 282,
      use: "outdoor",
      setBy: "unknown",
      setOnDateKey: null,
      outdoorWatts: 282,
    });
    await seedRide(test.store, { key: "b".repeat(64), startMs: msOf(19980301, "19:00:00.000") });
    expect((await rides(test, 19980301)).get("b".repeat(64))).toMatchObject({
      watts: 294,
      setBy: "coach",
      setOnDateKey: 19980301,
    });
  });

  it("uses the FTP intervals.icu applied to a ride, and knows none for an older ride without one", async () => {
    const test = await ftpHarness();
    await test.land({ ...RIDE, ftp: 290, updated: "1998-08-01T08:00:00.100+00:00" });
    await seedRide(test.store, { key: "c".repeat(64), startMs: msOf(19980601), icuFtp: 265 });
    await seedRide(test.store, { key: "d".repeat(64), startMs: msOf(19980602) });
    await seedRide(test.store, { key: "e".repeat(64), startMs: msOf(19980720), icuFtp: 279 });
    await seedRide(test.store, { key: "f".repeat(64), startMs: msOf(19980720) });
    await seedRide(test.store, { key: "1".repeat(64), startMs: msOf(19980805) });
    const ftps = await rides(test);
    expect(ftps.get("c".repeat(64))).toEqual({
      kind: "known",
      watts: 265,
      use: "outdoor",
      setBy: "unknown",
      setOnDateKey: null,
      outdoorWatts: null,
    });
    expect(ftps.get("d".repeat(64))).toEqual({ kind: "unknown" });
    expect(ftps.get("e".repeat(64))).toMatchObject({ watts: 279, setBy: "unknown" });
    expect(ftps.get("f".repeat(64))).toMatchObject({ watts: 282, setBy: "unknown" });
    expect(ftps.get("1".repeat(64))).toMatchObject({
      watts: 290,
      setBy: "you",
      setOnDateKey: 19980801,
    });
  });

  it("knows no FTP for a ride after the athlete cleared it in intervals.icu", async () => {
    const test = await ftpHarness();
    await test.land({ ...RIDE, ftp: null, updated: "1998-08-01T08:00:00.100+00:00" });
    await seedRide(test.store, { key: "2".repeat(64), startMs: msOf(19980805) });
    await seedRide(test.store, { key: "3".repeat(64), startMs: msOf(19980806), icuFtp: 282 });
    const ftps = await rides(test);
    expect(ftps.get("2".repeat(64))).toEqual({ kind: "unknown" });
    expect(ftps.get("3".repeat(64))).toMatchObject({ watts: 282, setBy: "unknown" });
  });

  it("uses the indoor FTP for an indoor ride and names the outdoor one beside it", async () => {
    const test = await ftpHarness({ ...RIDE, indoorFtp: 274 });
    await test.land({ ...RIDE, indoorFtp: 270, updated: "1998-08-01T08:00:00.100+00:00" });
    await seedRide(test.store, {
      key: "4".repeat(64),
      startMs: msOf(19980805),
      subSport: "indoor_cycling",
    });
    expect((await rides(test)).get("4".repeat(64))).toEqual({
      kind: "known",
      watts: 270,
      use: "indoor",
      setBy: "you",
      setOnDateKey: 19980801,
      outdoorWatts: 282,
    });
    expect(dateKeyOf(msOf(19980805))).toBe(19980805);
    expect(ATHLETE).toBe("i1998");
  });
});
