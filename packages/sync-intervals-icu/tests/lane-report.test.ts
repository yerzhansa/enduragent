import { RowRejection } from "@enduragent/kernel/reference/local-bundle";
import { describe, expect, it } from "vitest";
import { IntervalsHttpError } from "../src/http.js";
import { activityDropEvidence, attempt, LaneTally, type RowDrop } from "../src/lane-report.js";

const MARKER = "poison-marker-7f3a";

function drop(overrides: Partial<RowDrop> = {}): RowDrop {
  return { lane: "activities", payloadIndex: 0, externalId: null, localDate: null, phase: "decode",
    reason: "unclassified", field: null, errorName: null, ...overrides };
}

async function dropped(run: Promise<{ readonly ok: boolean; readonly drop?: RowDrop }>): Promise<RowDrop> {
  const outcome = await run;
  if (outcome.ok || outcome.drop === undefined) throw new Error("expected a drop");
  return outcome.drop;
}

describe("attempt", () => {
  it("returns the landed value", async () => {
    await expect(attempt("decode", { lane: "wellness", payloadIndex: 0 }, { id: "1998-07-17" }, async () => 7))
      .resolves.toEqual({ ok: true, value: 7 });
  });

  it("takes the reason and the field from a row rejection, and the phase from its reason", async () => {
    const site = { lane: "wellness", payloadIndex: 4 } as const;
    const row = { id: "1998-07-17" };

    expect(await dropped(attempt("decode", site, row, () => { throw new RowRejection("landing", "restingHR"); })))
      .toEqual({ lane: "wellness", payloadIndex: 4, externalId: "1998-07-17", localDate: "1998-07-17",
        phase: "landing", reason: "landing", field: "restingHR", errorName: null });
    expect(await dropped(attempt("landing", site, row, () => { throw new RowRejection("shape"); })))
      .toMatchObject({ phase: "decode", reason: "shape", field: null });
  });

  it("keeps a rejected field only when the wellness vocabulary declares it", async () => {
    const site = { lane: "wellness", payloadIndex: 0 } as const;

    expect((await dropped(attempt("decode", site, {}, () => { throw new RowRejection("decode", MARKER); }))).field).toBeNull();
    expect((await dropped(attempt("decode", site, {}, () => { throw new RowRejection("decode", "subjectiveFatigue"); }))).field)
      .toBe("subjectiveFatigue");
  });

  it("keeps the class name of an unknown error only when it is on the fixed list, and never its message", async () => {
    class Leaky extends Error { override name = MARKER; }
    const site = { lane: "activities", payloadIndex: 2 } as const;

    const unlisted = await dropped(attempt("landing", site, { id: 7 }, () => { throw new Leaky(MARKER); }));
    const listed = await dropped(attempt("landing", site, { id: 7 }, () => { throw new RangeError(MARKER); }));
    const thrownValue = await dropped(attempt("landing", site, { id: 7 }, () => { throw MARKER; }));

    expect(unlisted).toEqual({ lane: "activities", payloadIndex: 2, externalId: "7", localDate: null,
      phase: "landing", reason: "unclassified", field: null, errorName: null });
    expect(listed.errorName).toBe("RangeError");
    expect(thrownValue.errorName).toBeNull();
    expect((await dropped(attempt("decode", site, { id: 7 }, () => {
      throw Object.assign(new Error(MARKER), { name: "ZodError" });
    }))).errorName).toBe("ZodError");
    expect(JSON.stringify([unlisted, listed, thrownValue])).not.toContain(MARKER);
  });

  it("rethrows an error the caller says ends the capture", async () => {
    const fatal = new Error("budget");

    await expect(attempt("fetch", { lane: "streams", payloadIndex: null }, undefined, () => { throw fatal; },
      (error) => error === fatal)).rejects.toBe(fatal);
  });

  it("reports a failed request as a fetch of its status", async () => {
    const site = { lane: "streams", payloadIndex: null, activityId: "42" } as const;

    expect(await dropped(attempt("fetch", site, undefined, () => { throw new IntervalsHttpError("streams", 503, null); })))
      .toEqual({ lane: "streams", payloadIndex: null, externalId: "streams:42", localDate: null,
        phase: "fetch", reason: "fetch", field: "http_503", errorName: null });
  });

  it("keeps an activity id only in a safe shape, and a local date only when it is a civil date", async () => {
    const site = { lane: "activities", payloadIndex: 0 } as const;
    const fail = (): never => { throw new TypeError("bad"); };
    const identity = async (row: unknown) => {
      const { externalId, localDate } = await dropped(attempt("decode", site, row, fail));
      return [externalId, localDate];
    };

    expect(await identity({ id: 42, start_date_local: "1998-07-17T12:00:00" })).toEqual(["42", "1998-07-17"]);
    expect(await identity({ id: "ride-1.2", start_date_local: "1998-02-30T12:00:00" })).toEqual(["ride-1.2", null]);
    expect(await identity({ id: `free text ${MARKER}`, start_date_local: MARKER })).toEqual([null, null]);
    expect(await identity({ id: "a".repeat(65) })).toEqual([null, null]);
    expect(await identity({ id: 1.5 })).toEqual([null, null]);
    expect(await identity(MARKER)).toEqual([null, null]);
  });

  it("keeps the activity id of a recording only in a safe shape", async () => {
    const fail = (): never => { throw new TypeError("bad"); };
    const identity = async (activityId: string | undefined) => (await dropped(attempt("fetch",
      { lane: "streams", payloadIndex: null, ...(activityId === undefined ? {} : { activityId }) }, undefined, fail))).externalId;

    expect(await identity("ride-1.2")).toBe("streams:ride-1.2");
    expect(await identity(`free text ${MARKER}`)).toBeNull();
    expect(await identity("a".repeat(65))).toBeNull();
    expect(await identity(undefined)).toBeNull();
  });

  it("marks a withheld activity as source-restricted whatever the error was", async () => {
    const withheld = { id: "9001", source: "STRAVA", start_date_local: "1998-07-17T14:08:41" };

    expect(await dropped(attempt("decode", { lane: "activities", payloadIndex: 1 }, withheld, () => { throw new TypeError("bad"); })))
      .toMatchObject({ reason: "source-restricted", field: null, errorName: null, externalId: "9001", localDate: "1998-07-17" });
    expect(await dropped(attempt("decode", { lane: "wellness", payloadIndex: 1 }, withheld, () => { throw new RowRejection("shape"); })))
      .toMatchObject({ reason: "shape" });
  });

  it("keeps a sport setting id only when it is a whole number", async () => {
    const site = { lane: "settings", payloadIndex: 0 } as const;
    const fail = (): never => { throw new TypeError("bad"); };

    expect((await dropped(attempt("decode", site, { id: 7, athlete_id: MARKER }, fail))).externalId).toBe("7");
    expect((await dropped(attempt("decode", site, { id: MARKER }, fail))).externalId).toBeNull();
  });
});

describe("LaneTally", () => {
  it("counts each fetched row once and keeps failed requests outside the sum", () => {
    const tally = new LaneTally("activities");

    expect(tally.take({ ok: true, value: "a" })).toBe("a");
    expect(tally.take({ ok: false, drop: drop({ payloadIndex: 1 }) })).toBeUndefined();
    tally.missed(drop({ payloadIndex: null, phase: "fetch", reason: "fetch", field: "http_404" }));

    const report = tally.report();
    expect(report).toEqual({
      fetched: 2,
      landed: 1,
      drops: [drop({ payloadIndex: 1 })],
      unfetched: [drop({ payloadIndex: null, phase: "fetch", reason: "fetch", field: "http_404" })],
    });
    expect(report.fetched).toBe(report.landed + report.drops.length);
  });

  it("refuses a drop from another lane without counting it", () => {
    const tally = new LaneTally("wellness");

    expect(() => tally.take({ ok: false, drop: drop() })).toThrow("row drop belongs to another lane");
    expect(() => tally.missed(drop())).toThrow("row drop belongs to another lane");
    expect(tally.report()).toEqual({ fetched: 0, landed: 0, drops: [], unfetched: [] });
  });
});

describe("activityDropEvidence", () => {
  it("splits withheld rows from the rest and lists each dropped date once, in order", () => {
    const tally = new LaneTally("activities");
    tally.take({ ok: false, drop: drop({ reason: "source-restricted", localDate: "1998-07-17" }) });
    tally.take({ ok: false, drop: drop({ localDate: "1998-07-03" }) });
    tally.take({ ok: false, drop: drop({ reason: "source-restricted", localDate: "1998-07-17" }) });
    tally.take({ ok: false, drop: drop() });
    tally.missed(drop({ phase: "fetch", reason: "fetch", localDate: "1998-01-01" }));

    expect(activityDropEvidence(tally.report())).toEqual({
      sourceRestricted: 2,
      other: 2,
      datedLocalDates: ["1998-07-03", "1998-07-17"],
      undatedCount: 1,
    });
  });
});
