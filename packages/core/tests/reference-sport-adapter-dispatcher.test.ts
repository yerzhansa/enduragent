import { describe, it, expect, vi, afterEach } from "vitest";
import type { Activity } from "intervals-icu-api";
import type { ReferenceSportAdapter } from "../src/reference/sport-adapter.js";
import type { IntervalsActivityType } from "../src/sport.js";
import {
  findAdapterForActivity,
  runAdaptersForActivities,
} from "../src/reference/sport-adapter-dispatcher.js";

const cyclingAdapter: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: [300, 1200, 3600],
  dfaValidated: true,
  anchorType: "ftp",
};

const runningAdapter: ReferenceSportAdapter = {
  activityTypes: ["Run", "TrailRun"],
  zoneBasis: "pace",
  decouplingBasis: "pace",
  sustainabilityAnchors: [60, 300],
  dfaValidated: false,
  anchorType: "critical-speed",
};

function activity(type: string): Activity {
  return { id: "12345", startDateLocal: "1998-06-04T12:00:00", type } as Activity;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findAdapterForActivity", () => {
  it("returns null for an empty adapter array without throwing", () => {
    expect(findAdapterForActivity([], activity("Ride"))).toBeNull();
  });

  it("routes Ride and VirtualRide to the single cycling adapter", () => {
    expect(findAdapterForActivity([cyclingAdapter], activity("Ride"))).toBe(cyclingAdapter);
    expect(findAdapterForActivity([cyclingAdapter], activity("VirtualRide"))).toBe(cyclingAdapter);
  });

  it("returns null for an out-of-sport type the lone cycling adapter does not cover", () => {
    expect(findAdapterForActivity([cyclingAdapter], activity("Run"))).toBeNull();
  });

  it("routes each type to its own adapter when two disjoint adapters are present", () => {
    const adapters = [cyclingAdapter, runningAdapter];
    expect(findAdapterForActivity(adapters, activity("Ride"))).toBe(cyclingAdapter);
    expect(findAdapterForActivity(adapters, activity("TrailRun"))).toBe(runningAdapter);
  });

  it("routes the duathlon spread: Ride to cycling, Run to running", () => {
    const adapters = [cyclingAdapter, runningAdapter];
    expect(findAdapterForActivity(adapters, activity("Ride"))).toBe(cyclingAdapter);
    expect(findAdapterForActivity(adapters, activity("Run"))).toBe(runningAdapter);
  });

  it("routes GravelRide to the cycling adapter via family even though it is not listed", () => {
    const adapter = findAdapterForActivity([cyclingAdapter], activity("GravelRide"));
    expect(adapter).toBe(cyclingAdapter);
  });

  it("routes EBikeRide to the cycling adapter via the family table", () => {
    expect(findAdapterForActivity([cyclingAdapter], activity("EBikeRide"))).toBe(cyclingAdapter);
  });

  it("routes MountainBikeRide to the cycling adapter via the family table", () => {
    expect(findAdapterForActivity([cyclingAdapter], activity("MountainBikeRide"))).toBe(
      cyclingAdapter,
    );
  });

  it("returns null for a type absent from the family table", () => {
    expect(
      findAdapterForActivity([cyclingAdapter, runningAdapter], activity("Skydive")),
    ).toBeNull();
  });

  it("returns null without warning for a Strava stub whose type is null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = {
      id: "12345",
      startDateLocal: "1998-08-20T14:08:41",
      type: null,
    } as unknown as Activity;
    expect(findAdapterForActivity([cyclingAdapter], stub)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null without warning for a malformed row whose type is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = { id: "12345", startDateLocal: "1998-06-04T12:00:00" } as unknown as Activity;
    expect(findAdapterForActivity([cyclingAdapter], malformed)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("runAdaptersForActivities", () => {
  const cyclingTypes: readonly IntervalsActivityType[] = ["Ride", "VirtualRide"];

  it("returns one AdapterRun per matched activity and pairs the covering adapter", () => {
    const runs = runAdaptersForActivities([cyclingAdapter], cyclingTypes, [
      activity("Ride"),
      activity("VirtualRide"),
    ]);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.adapter === cyclingAdapter)).toBe(true);
    expect(runs.map((r) => r.activity.type)).toEqual(["Ride", "VirtualRide"]);
  });

  it("does not invoke computeDfa or computePowerCurve on the matched adapter", () => {
    const dfaSpy = vi.fn(() => null);
    const curveSpy = vi.fn(() => null);
    const spyAdapter: ReferenceSportAdapter = {
      ...cyclingAdapter,
      computeDfa: dfaSpy,
      computePowerCurve: curveSpy,
    };
    runAdaptersForActivities([spyAdapter], cyclingTypes, [activity("Ride")]);
    expect(dfaSpy).not.toHaveBeenCalled();
    expect(curveSpy).not.toHaveBeenCalled();
  });

  it("warns exactly once for repeated in-sport activities with no covering adapter", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sportTypes: readonly IntervalsActivityType[] = ["Ride", "VirtualRide", "Run"];
    const activities = Array.from({ length: 5 }, () => activity("Run"));
    const runs = runAdaptersForActivities([cyclingAdapter], sportTypes, activities);
    expect(runs).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent for out-of-sport types and warns for the same type when in-sport", () => {
    const warnSilent = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outOfSport = runAdaptersForActivities([cyclingAdapter], cyclingTypes, [activity("Run")]);
    expect(outOfSport).toHaveLength(0);
    expect(warnSilent).not.toHaveBeenCalled();
    warnSilent.mockRestore();

    const warnInSport = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inSport = runAdaptersForActivities(
      [cyclingAdapter],
      ["Ride", "VirtualRide", "Run"],
      [activity("Run")],
    );
    expect(inSport).toHaveLength(0);
    expect(warnInSport).toHaveBeenCalledTimes(1);
  });

  it("silently skips an out-of-sport type without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runs = runAdaptersForActivities([cyclingAdapter], cyclingTypes, [activity("Swim")]);
    expect(runs).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("silently skips a Strava stub whose type is null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = {
      id: "12345",
      startDateLocal: "1998-08-20T14:08:41",
      type: null,
    } as unknown as Activity;
    const runs = runAdaptersForActivities([cyclingAdapter], cyclingTypes, [stub]);
    expect(runs).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("silently skips a malformed row whose type is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = { id: "12345", startDateLocal: "1998-06-04T12:00:00" } as unknown as Activity;
    const runs = runAdaptersForActivities([cyclingAdapter], cyclingTypes, [malformed]);
    expect(runs).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
