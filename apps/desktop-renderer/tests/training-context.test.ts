import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, expect, it, vi } from "vitest";
import { CoachClientDisconnectedError, type CoachClient } from "@enduragent/coach-client";
import type { AthleteState, CyclingTrainingContext } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import {
  createTrainingContextController,
  type TrainingContextViewState,
} from "../src/training-context/controller";
import {
  formatDistance,
  formatPercentage,
  formatRidingDuration,
  formatSleepDuration,
  formatUtcTimestamp,
  formatWholeNumber,
} from "../src/training-context/format";

const context: CyclingTrainingContext = {
  performanceProgress: { kind: "unavailable", reason: "not-synced" },
  recentRides: { kind: "unknown", reason: "no-recent-rides" },
  trainingHistory: { kind: "unavailable", reason: "not-synced" },
  anchorZones: { kind: "unknown", reason: "missing-anchor" },
  cyclingLoad: {
    kind: "computed",
    asOf: "1998-07-18T00:00:00.000Z",
    source: "intervals.icu",
    windowDays: 7,
    value: 120,
    activityCount: 2,
    missingLoadCount: 1,
  },
  plan: { kind: "unknown", reason: "no-plan" },
  adherence: { kind: "unknown", reason: "insufficient-data" },
  wellnessTrend: { kind: "unknown", reason: "no-wellness" },
};

function athlete(trainingContext: CyclingTrainingContext | undefined = context): AthleteState {
  return {
    schemaVersion: "3",
    lastUpdated: "1998-07-18T00:00:00.000Z",
    freshness: "flag",
    degraded: true,
    lastSynced: "1998-07-17T23:00:00.000Z",
    athleteProfile: { hidden: true },
    currentStatus: { hidden: true },
    derivedMetrics: { hidden: true },
    recentActivities: [{ hidden: true }],
    plannedWorkouts: [{ hidden: true }],
    wellness: { hidden: true },
    ...(trainingContext === undefined ? {} : { trainingContext }),
  };
}

function providerWith(call: CoachClient["call"]): DesktopCoachClientProvider {
  const client = {
    handshake: {} as CoachClient["handshake"],
    call,
    close: vi.fn(async () => {}),
  } as CoachClient;
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    close: vi.fn(async () => {}),
  };
}

describe("training context controller", () => {
  it("fetches canonical state and units once on start without exposing raw state fields", async () => {
    const calls: string[] = [];
    const clients = providerWith((async (method: string) => {
      calls.push(method);
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") return { value: "imperial", source: "athlete" };
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await Promise.all([controller.start(), controller.start()]);
    expect(calls.sort()).toEqual(["getAthleteState", "getUnitsPreference"]);
    expect(states.at(-1)).toEqual({
      status: "ready",
      metadata: {
        lastUpdated: "1998-07-18T00:00:00.000Z",
        lastSynced: "1998-07-17T23:00:00.000Z",
        freshness: "flag",
        degraded: true,
      },
      trainingContext: context,
      unitsPreference: { status: "ready", value: "imperial", source: "athlete" },
    });
    expect(JSON.stringify(states.at(-1))).not.toContain("hidden");
  });

  it("uses the explicit fallback for an older state and retains it on refresh failure", async () => {
    let stateCalls = 0;
    const clients = providerWith((async (method: string) => {
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "getAthleteState") {
        stateCalls += 1;
        if (stateCalls === 1) {
          const older = athlete();
          delete older.trainingContext;
          return older;
        }
        throw new Error("unavailable");
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    const previous = states.at(-1)?.trainingContext;
    await controller.refresh();
    expect(states.at(-1)?.status).toBe("refresh-unavailable");
    expect(states.at(-1)?.trainingContext).toEqual(previous);
    expect(states.at(-1)?.trainingContext.anchorZones).toEqual({
      kind: "unknown",
      reason: "not-synced",
    });
  });

  it("coalesces refreshes during an active read into one post-flight request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stateCalls = 0;
    const clients = providerWith((async (method: string) => {
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "getAthleteState") {
        stateCalls += 1;
        if (stateCalls === 2) await gate;
        return { ...athlete(), lastUpdated: `1998-07-0${stateCalls}T00:00:00.000Z` };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    const first = controller.refresh();
    const second = controller.refresh();
    release();
    await Promise.all([first, second]);
    expect(stateCalls).toBe(3);
    expect(states.at(-1)?.metadata?.lastUpdated).toBe("1998-07-03T00:00:00.000Z");
  });

  it("reconnects the next athlete-state read after a disconnect", async () => {
    let stateCalls = 0;
    const clients = providerWith((async (method: string) => {
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "getAthleteState") {
        stateCalls += 1;
        if (stateCalls === 1) throw new CoachClientDisconnectedError(1006, "synthetic");
        return athlete();
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    await controller.refresh();
    expect(clients.reconnect).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("uses a shared recovered client instead of reconnecting a stale failed instance", async () => {
    const failed = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method: string) => {
        if (method === "getAthleteState") {
          throw new CoachClientDisconnectedError(1006, "synthetic");
        }
        return { value: "metric", source: "default" };
      }) as CoachClient["call"],
      close: vi.fn(async () => {}),
    } as CoachClient;
    const recovered = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method: string) => {
        if (method === "getAthleteState") return athlete();
        return { value: "metric", source: "default" };
      }) as CoachClient["call"],
      close: vi.fn(async () => {}),
    } as CoachClient;
    let current = failed;
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => current),
      reconnect: vi.fn(async () => recovered),
      close: vi.fn(async () => {}),
    };
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    current = recovered;
    await controller.refresh();
    expect(clients.reconnect).not.toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("renders only the authoritative units result and retains selection on failed save", async () => {
    let fail = false;
    const calls: Array<{ method: string; request: unknown }> = [];
    const clients = providerWith((async (method: string, request: unknown) => {
      calls.push({ method, request });
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "setUnitsPreference") {
        if (fail) throw new Error("save failed");
        return { value: "imperial", source: "cycling" };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    await controller.setUnitsPreference("imperial");
    expect(states.at(-1)?.unitsPreference).toEqual({
      status: "ready",
      value: "imperial",
      source: "cycling",
    });
    fail = true;
    await controller.setUnitsPreference("metric");
    expect(states.at(-1)?.unitsPreference).toEqual({
      status: "unavailable",
      value: "imperial",
      source: "cycling",
    });
    expect(calls.filter((entry) => entry.method === "setUnitsPreference")).toEqual([
      { method: "setUnitsPreference", request: { value: "imperial" } },
      { method: "setUnitsPreference", request: { value: "metric" } },
    ]);
  });

  it("reconciles a disconnected save before applying the next explicit selection", async () => {
    let stored: "metric" | "imperial" = "metric";
    let disconnected = true;
    const calls: string[] = [];
    const clients = providerWith((async (method: string, request: unknown) => {
      calls.push(method);
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") {
        return { value: stored, source: stored === "metric" ? "default" : "cycling" };
      }
      if (method === "setUnitsPreference") {
        if (disconnected) {
          disconnected = false;
          throw new CoachClientDisconnectedError(1006, "synthetic");
        }
        stored = (request as { value: "metric" | "imperial" }).value;
        return { value: stored, source: "cycling" };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const controller = createTrainingContextController({ clients, view: { render() {} } });
    await controller.start();
    await controller.setUnitsPreference("imperial");
    await controller.setUnitsPreference("imperial");
    expect(clients.reconnect).toHaveBeenCalledTimes(1);
    expect(calls.slice(-3)).toEqual([
      "setUnitsPreference",
      "getUnitsPreference",
      "setUnitsPreference",
    ]);
    expect(stored).toBe("imperial");
  });

  it("reconnects and reconciles when the initial units read disconnects", async () => {
    let unitReads = 0;
    let stored: "metric" | "imperial" = "metric";
    const clients = providerWith((async (method: string, request: unknown) => {
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") {
        unitReads += 1;
        if (unitReads === 1) throw new CoachClientDisconnectedError(1006, "synthetic");
        return { value: stored, source: "default" };
      }
      if (method === "setUnitsPreference") {
        stored = (request as { value: "metric" | "imperial" }).value;
        return { value: stored, source: "cycling" };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const controller = createTrainingContextController({ clients, view: { render() {} } });
    await controller.start();
    await controller.setUnitsPreference("imperial");
    expect(clients.reconnect).toHaveBeenCalledTimes(1);
    expect(stored).toBe("imperial");
  });

  it("ignores late responses after disposal", async () => {
    let resolve!: (value: AthleteState) => void;
    const pending = new Promise<AthleteState>((accept) => {
      resolve = accept;
    });
    const clients = providerWith((async (method: string) => {
      if (method === "getAthleteState") return pending;
      return { value: "metric", source: "default" };
    }) as CoachClient["call"]);
    const render = vi.fn();
    const controller = createTrainingContextController({ clients, view: { render } });
    const started = controller.start();
    controller.dispose();
    resolve(athlete());
    await started;
    expect(render).toHaveBeenCalledTimes(3);
  });
});

describe("training context display formatters", () => {
  it("formats display values through the English phrasebook", async () => {
    const { say, format } = await createPhrasebook({ tag: "en", locale: "en-US" });
    expect(formatWholeNumber(12.6, format)).toBe("13");
    expect(say(formatPercentage(0.756, format))).toBe("76%");
    expect(say(formatSleepDuration(27_901, format))).toBe("7h 45m");
    expect(say(formatRidingDuration(7_200, format))).toBe("2h");
    expect(say(formatRidingDuration(5_100, format))).toBe("1h 25m");
    expect(say(formatDistance(42_120, "metric", format))).toBe("42.1 km");
    expect(say(formatDistance(42_120, "imperial", format))).toBe("26.2 mi");
  });

  it("distinguishes same-day sync seconds while mutation labels remain date-only", () => {
    expect(formatUtcTimestamp("1998-07-18T12:34:56.999Z")).toBe("1998-07-18 12:34:56 UTC");
    expect(formatUtcTimestamp("1998-07-18T12:34:57.001Z")).toBe("1998-07-18 12:34:57 UTC");
  });

  it("normalizes valid offsets to UTC and uses fixed copy for invalid sync times", () => {
    expect(formatUtcTimestamp("1998-07-18T18:34:56+06:00")).toBe("1998-07-18 12:34:56 UTC");
    expect(formatUtcTimestamp("not-an-instant")).toBe("Unknown sync time");
    expect(formatUtcTimestamp("1998-02-30T12:34:56Z")).toBe("Unknown sync time");
  });
});
