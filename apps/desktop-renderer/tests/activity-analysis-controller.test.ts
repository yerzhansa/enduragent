import type { CoachClient } from "@enduragent/coach-client";
import type { ActivityAnalysisResult } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import {
  createRideAnalysisController,
  type RideAnalysisViewState,
} from "../src/activity-analysis/controller";

const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);
const REVISION = "c".repeat(64);

interface Deferred {
  readonly promise: Promise<ActivityAnalysisResult>;
  resolve(value: ActivityAnalysisResult): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: (value: ActivityAnalysisResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ActivityAnalysisResult>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function result(id = FIRST): ActivityAnalysisResult {
  return {
    schemaVersion: 1,
    activity: {
      id,
      workoutId: "d".repeat(64),
      sessionSequence: 0,
      isMultisport: false,
      sport: "cycling",
      subSport: "road",
      isTransition: false,
      startEpochSeconds: 899_985_600,
      timezoneOffsetSeconds: 0,
      localDate: "1998-07-06",
      elapsedSeconds: 3_600,
      timerSeconds: 3_600,
      movingSeconds: 3_600,
      distanceMeters: 36_000,
    },
    revision: REVISION,
    sections: {
      aerobicDrift: {
        kind: "computed",
        data: {
          method: "local-time-weighted-efficiency-factor",
          firstHalf: {
            durationSeconds: 1_800,
            sampleCount: 1_800,
            averagePowerWatts: 200,
            averageHeartRateBpm: 140,
            efficiencyFactor: 1.43,
          },
          secondHalf: {
            durationSeconds: 1_800,
            sampleCount: 1_800,
            averagePowerWatts: 200,
            averageHeartRateBpm: 145,
            efficiencyFactor: 1.38,
          },
          decouplingPercent: 3.5,
          coverage: {
            totalSamples: 3_600,
            validSamples: 3_600,
            includedDurationSeconds: 3_600,
            windowDurationSeconds: 3_600,
            fraction: 1,
          },
          evidence: "standard",
          limitations: [],
        },
        provenance: {
          source: "local-canonical",
          delivery: "live",
          observedAt: "1998-07-06T12:00:00.000Z",
        },
      },
    },
  };
}

function setup(call: CoachClient["call"]) {
  const states: RideAnalysisViewState[] = [];
  const client = { call } as CoachClient;
  const clients: DesktopCoachClientProvider = {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    close: vi.fn(async () => {}),
  };
  const controller = createRideAnalysisController({
    clients,
    view: { render: (state) => states.push(state) },
  });
  return { controller, states, clients };
}

describe("ride analysis controller", () => {
  it("waits for the disclosure before loading the selected canonical ride", async () => {
    const call = vi.fn(async () => result()) as unknown as CoachClient["call"];
    const { controller, states } = setup(call);

    await controller.select(FIRST);

    expect(call).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ activityId: FIRST, status: "idle" });

    await controller.start();

    expect(call).toHaveBeenCalledWith("getActivityAnalysis", {
      canonicalActivityId: FIRST,
      sections: [
        "aerobic-drift",
        "intervals",
        "best-efforts",
        "power-distribution",
        "heart-rate-distribution",
        "power-heart-rate",
      ],
    });
    expect(vi.mocked(call).mock.calls[0]).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({
      activityId: FIRST,
      status: "ready",
      revision: REVISION,
      sections: { aerobicDrift: { kind: "computed" } },
    });
    expect(JSON.stringify(states.at(-1))).not.toContain("provider-");
  });

  it.each([
    ["answer", (settle: Deferred) => settle.resolve(result(FIRST))],
    ["failure", (settle: Deferred) => settle.reject(new Error("private late failure"))],
  ])(
    "leaves obsolete work running and ignores its late %s when the selection changes",
    async (_kind, settleLate) => {
      const first = deferred();
      const call = vi.fn((_method: string, request: { canonicalActivityId: string }) =>
        request.canonicalActivityId === SECOND ? Promise.resolve(result(SECOND)) : first.promise,
      ) as unknown as CoachClient["call"];
      const { controller, states } = setup(call);

      await controller.select(FIRST);
      const pending = controller.start();
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
      await controller.select(SECOND);
      await controller.start();
      settleLate(first);
      await pending;

      expect(states.at(-1)).toMatchObject({ activityId: SECOND, status: "ready" });
      expect(JSON.stringify(states)).not.toContain("private late failure");
    },
  );

  it("preserves completed evidence when a refresh transport fails", async () => {
    let fail = false;
    const call = vi.fn(async () => {
      if (fail) throw new Error("private transport detail");
      return result();
    }) as unknown as CoachClient["call"];
    const { controller, states } = setup(call);

    await controller.select(FIRST);
    await controller.start();
    fail = true;
    await controller.load(["aerobic-drift"], true);

    expect(states.at(-1)).toMatchObject({
      activityId: FIRST,
      status: "refresh-unavailable",
      sections: { aerobicDrift: { kind: "computed" } },
      failedSections: ["aerobic-drift"],
    });
    expect(JSON.stringify(states.at(-1))).not.toContain("private transport detail");
  });

  it("tracks a failed section without marking completed sibling evidence as failed", async () => {
    let fail = false;
    const call = vi.fn(async () => {
      if (fail) throw new Error("private interval failure");
      return result();
    }) as unknown as CoachClient["call"];
    const { controller, states } = setup(call);
    await controller.select(FIRST);
    await controller.start();

    fail = true;
    await controller.load(["intervals"], true);

    expect(states.at(-1)).toMatchObject({
      status: "refresh-unavailable",
      failedSections: ["intervals"],
      sections: { aerobicDrift: { kind: "computed" } },
    });
  });

  it("clears analysis state and cancels work when the ride closes", async () => {
    const call = vi.fn(async () => result()) as unknown as CoachClient["call"];
    const { controller, states } = setup(call);
    await controller.select(FIRST);
    await controller.start();

    await controller.select(null);

    expect(states.at(-1)).toMatchObject({
      activityId: null,
      status: "idle",
      sections: {},
    });
  });

  it("reuses successful analysis when a ride is reopened during the session", async () => {
    const call = vi.fn(async () => result()) as unknown as CoachClient["call"];
    const { controller, states } = setup(call);

    await controller.select(FIRST);
    await controller.start();
    await controller.select(null);
    await controller.select(FIRST);

    expect(states.at(-1)).toMatchObject({
      activityId: FIRST,
      status: "ready",
      revision: REVISION,
    });
    await controller.start();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached analysis after sync success so reopening reloads the ride", async () => {
    const call = vi.fn(async () => result()) as unknown as CoachClient["call"];
    const { controller, states } = setup(call);

    await controller.select(FIRST);
    await controller.start();
    await controller.select(null);

    controller.invalidate();
    await controller.select(FIRST);

    expect(states.at(-1)).toMatchObject({
      activityId: FIRST,
      status: "idle",
      revision: null,
    });
    await controller.start();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("restarts in-flight analysis after cache invalidation", async () => {
    let resolveFirst!: (value: ActivityAnalysisResult) => void;
    let callCount = 0;
    const refreshedRevision = "e".repeat(64);
    const call = vi.fn(() => {
      callCount += 1;
      if (callCount > 1) return Promise.resolve({ ...result(), revision: refreshedRevision });
      return new Promise<ActivityAnalysisResult>((resolve) => {
        resolveFirst = resolve;
      });
    }) as unknown as CoachClient["call"];
    const { controller, states } = setup(call);

    await controller.select(FIRST);
    const pending = controller.start();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    controller.invalidate();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    resolveFirst(result());
    await pending;

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        activityId: FIRST,
        status: "ready",
        revision: refreshedRevision,
      }),
    );
  });
});
