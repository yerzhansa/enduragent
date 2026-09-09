import { describe, it, expect } from "vitest";
import type { AthleteDataReaderPort, AthleteReadResult } from "../src/host-ports.js";
import { summarizeStreams } from "../src/sport/stream-summary.js";
import { createPureCoreIntervalsTools } from "../src/sport/platform-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: unknown };

function missing(): Promise<AthleteReadResult<never>> {
  return Promise.resolve({ ok: false, error: "not_found", message: "not found" });
}

function makeFakeReader(result: AnyResult): AthleteDataReaderPort {
  return {
    getAthlete: missing,
    listWellness: missing,
    listActivities: missing,
    getActivity: missing,
    getStreams: async () => {
      if (!result.ok) {
        throw Object.assign(new Error("platform read failed"), {
          name: "PlatformApiError",
          apiError: result.error,
        });
      }
      return result;
    },
    listCalendar: missing,
    freshness: () => undefined,
  };
}

const threeHourRide = () => ({
  watts: Array(10800).fill(250),
  heartrate: Array(10800).fill(150),
  cadence: Array(10800).fill(90),
  time: Array.from({ length: 10800 }, (_, i) => i),
  altitude: Array(10800).fill(500),
});

describe("summarizeStreams", () => {
  it("reports min, max, mean and the sample count for a channel", () => {
    const out = summarizeStreams({ watts: [100, 200, 300, 400] });
    expect(out.channels.watts).toEqual({ min: 100, max: 400, mean: 250 });
    expect(out.sampleCount).toBe(4);
  });

  it("preserves true peaks over the full channel", () => {
    const watts = [...Array(599).fill(100), 900];
    const out = summarizeStreams({ watts });
    expect(out.channels.watts.max).toBe(900);
    expect(out.channels.watts.min).toBe(100);
    expect(out.channels.watts.mean).toBe(101.3);
  });

  it("missing or non-array channels do not throw (manual-entry activity)", () => {
    const out = summarizeStreams({
      heartrate: [120, 121, 122],
      watts: undefined as unknown as number[],
      cadence: "nope" as unknown as number[],
    });
    expect(out.channels.heartrate).toBeDefined();
    expect(out.channels.watts).toBeUndefined();
    expect(out.channels.cadence).toBeUndefined();
  });

  it("a channel with a null gap reports the mean over present samples only", () => {
    const out = summarizeStreams({
      watts: [100, null as unknown as number, 104],
    });
    expect(out.channels.watts).toEqual({ min: 100, max: 104, mean: 102 });
    expect(out.sampleCount).toBe(3);
  });

  it("an all-null channel is dropped instead of producing NaN", () => {
    const out = summarizeStreams({ watts: [null, null] as unknown as number[] });
    expect(out.channels.watts).toBeUndefined();
    expect(out.sampleCount).toBe(0);
  });

  it("accepts the live array-of-channel shape from the streams endpoint", () => {
    const out = summarizeStreams([
      { type: "watts", data: Array(600).fill(200) },
      { type: "heartrate", data: Array(600).fill(150) },
    ]);
    expect(out.channels.watts).toEqual({ min: 200, max: 200, mean: 200 });
    expect(out.channels.heartrate).toEqual({ min: 150, max: 150, mean: 150 });
    expect(out.sampleCount).toBe(600);
  });

  it("a 3 h five-channel ride serializes to well under 1,000 characters", () => {
    const serialized = JSON.stringify(summarizeStreams(threeHourRide()));
    expect(serialized.length).toBeLessThan(1_000);
    expect(serialized).not.toContain("samples");
    expect(serialized).not.toContain("bins");
  });

  it("the streams tool returns the summary, not the raw value", async () => {
    const reader = makeFakeReader({ ok: true, value: threeHourRide() });
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const out = (await tools.intervals_fetch_streams!.execute!(
      { activityId: 12345 },
      {} as never,
    )) as Record<string, unknown>;
    expect(out).toEqual({
      sampleCount: 10800,
      channels: {
        watts: { min: 250, max: 250, mean: 250 },
        heartrate: { min: 150, max: 150, mean: 150 },
        cadence: { min: 90, max: 90, mean: 90 },
        time: { min: 0, max: 10799, mean: 5399.5 },
        altitude: { min: 500, max: 500, mean: 500 },
      },
    });
  });

  it("the streams tool summarizes the live array-of-channel payload", async () => {
    const live = [
      { type: "watts", data: Array(10800).fill(250) },
      { type: "heartrate", data: Array(10800).fill(150) },
    ];
    const reader = makeFakeReader({ ok: true, value: live });
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const out = (await tools.intervals_fetch_streams!.execute!(
      { activityId: 12345 },
      {} as never,
    )) as { sampleCount: number; channels: Record<string, unknown> };
    expect(out.sampleCount).toBe(10800);
    expect(Object.keys(out.channels)).toEqual(["watts", "heartrate"]);
    expect(out).not.toHaveProperty("bins");
  });

  it("typed error object on the streams failure path", async () => {
    const notFound = makeFakeReader({
      ok: false,
      error: { kind: "NotFound", status: 404, body: undefined },
    });
    const nfTools = createPureCoreIntervalsTools(null, "UTC", notFound);
    const nfOut = (await nfTools.intervals_fetch_streams!.execute!(
      { activityId: 1 },
      {} as never,
    )) as { error: string; status?: number };
    expect(nfOut.error).toBe("NotFound");
    expect(nfOut.status).toBe(404);

    const timeout = makeFakeReader({
      ok: false,
      error: { kind: "Timeout", message: "slow down" },
    });
    const toTools = createPureCoreIntervalsTools(null, "UTC", timeout);
    const toOut = (await toTools.intervals_fetch_streams!.execute!(
      { activityId: 1 },
      {} as never,
    )) as { error: string; message?: string };
    expect(toOut.error).toBe("Timeout");
    expect(toOut.message).toBe("slow down");
  });
});
