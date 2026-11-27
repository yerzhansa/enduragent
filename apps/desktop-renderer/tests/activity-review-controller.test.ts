import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import {
  createActivityReviewController,
  type ActivityReviewState,
} from "../src/activity-review/controller";
import { PLAN_ID, TODAY, planWorkout, ride, rideId, rides } from "./activity-review-fixture";

const ENDURANCE = planWorkout(1, TODAY, "Easy endurance");
const ASKED = ride("a", TODAY, { match: { kind: "suggested", ...ENDURANCE } });
const EARLIER = ride("b", 19980819);

interface Pending {
  resolve(value: PlanCalendarRpcResult): void;
  reject(error: Error): void;
}

function harness() {
  const states: ActivityReviewState[] = [];
  const reads: { startDateKey: number; endDateKey: number }[] = [];
  const decisions: unknown[] = [];
  const readReplies: Pending[] = [];
  const decideReplies: Pending[] = [];
  const controller = createActivityReviewController({
    read: (range) => {
      reads.push(range);
      return new Promise((resolve, reject) => readReplies.push({ resolve, reject }));
    },
    decide: (request) => {
      decisions.push(request);
      return new Promise((resolve, reject) => decideReplies.push({ resolve, reject }));
    },
    localTodayDateKey: () => TODAY,
    publish: (state) => states.push(state),
  });
  const last = () => states.at(-1);
  const ready = () => {
    const state = last();
    if (state?.kind !== "ready") throw new Error(`Expected ready, got ${state?.kind}`);
    return state;
  };
  const opened = async () => {
    const opening = controller.open();
    readReplies.at(-1)?.resolve(rides([ASKED, EARLIER]));
    await opening;
  };
  return { controller, states, reads, decisions, readReplies, decideReplies, last, ready, opened };
}

describe("the Activity review controller", () => {
  it("reads the last 120 days on open and selects the newest ride", async () => {
    const test = harness();
    const opening = test.controller.open();
    expect(test.last()).toEqual({ kind: "loading" });
    expect(test.reads).toEqual([{ startDateKey: 19980423, endDateKey: TODAY }]);
    test.readReplies[0]?.resolve(rides([EARLIER, ASKED]));
    await opening;
    expect(test.ready()).toMatchObject({
      selectedId: null,
      refresh: "idle",
      choices: "closed",
      saving: "idle",
    });
  });

  it("shows the page as unavailable when the first read fails, and keeps the list when a refresh fails", async () => {
    const test = harness();
    const opening = test.controller.open();
    test.readReplies[0]?.reject(new Error("daemon gone"));
    await opening;
    expect(test.last()).toEqual({ kind: "unavailable" });
    await test.opened();
    const refreshing = test.controller.refresh();
    expect(test.ready().refresh).toBe("refreshing");
    test.readReplies.at(-1)?.resolve({ status: "refused", reason: "no-active-plan" });
    await refreshing;
    expect(test.ready()).toMatchObject({ refresh: "failed", read: { rides: [ASKED, EARLIER] } });
  });

  it("keeps the selected ride across a refresh, falls back to the newest when it is gone, and starts from the newest on open", async () => {
    const test = harness();
    await test.opened();
    test.controller.select(rideId("b"));
    let refreshing = test.controller.refresh();
    test.readReplies.at(-1)?.resolve(rides([ASKED, EARLIER]));
    await refreshing;
    expect(test.ready().selectedId).toBe(rideId("b"));
    refreshing = test.controller.refresh();
    test.readReplies.at(-1)?.resolve(rides([ASKED]));
    await refreshing;
    expect(test.ready().selectedId).toBe(rideId("a"));
    test.controller.select(rideId("a"));
    const reopening = test.controller.open();
    test.readReplies.at(-1)?.resolve(rides([ASKED, EARLIER]));
    await reopening;
    expect(test.ready().selectedId).toBeNull();
  });

  it("keeps only the newest read when two overlap", async () => {
    const test = harness();
    const first = test.controller.open();
    const second = test.controller.refresh();
    test.readReplies[1]?.resolve(rides([ASKED]));
    await second;
    test.readReplies[0]?.resolve(rides([EARLIER]));
    await first;
    expect(test.ready().read.rides).toEqual([ASKED]);
  });

  it("confirms the selected ride, shows the answer, then reads the list again", async () => {
    const test = harness();
    await test.opened();
    const answered = ride("a", TODAY, {
      match: { kind: "confirmed", ...ENDURANCE, outcome: "done-as-planned", by: "you" },
    });
    const deciding = test.controller.decide({
      kind: "confirm",
      planWorkoutId: ENDURANCE.planWorkoutId,
    });
    expect(test.ready()).toMatchObject({ saving: "saving", selectedId: rideId("a") });
    test.controller.select(rideId("b"));
    expect(test.ready().selectedId).toBe(rideId("a"));
    expect(test.decisions).toEqual([
      {
        planId: PLAN_ID,
        activityId: rideId("a"),
        decision: { kind: "confirm", planWorkoutId: ENDURANCE.planWorkoutId },
      },
    ]);
    test.decideReplies[0]?.resolve({ status: "ride", ride: answered });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.ready()).toMatchObject({
      saving: "idle",
      choices: "closed",
      refresh: "refreshing",
      read: { rides: [answered, EARLIER] },
    });
    test.readReplies.at(-1)?.resolve(rides([answered, EARLIER]));
    await deciding;
    expect(test.reads).toHaveLength(2);
    expect(test.ready()).toMatchObject({ refresh: "idle", saving: "idle" });
  });

  it("says when the match changed meanwhile, or the app did not answer", async () => {
    const test = harness();
    await test.opened();
    test.controller.change();
    let deciding = test.controller.decide({ kind: "extra" });
    test.decideReplies[0]?.resolve({ status: "refused", reason: "match-changed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.ready().saving).toBe("refused");
    test.readReplies.at(-1)?.resolve(rides([ASKED, EARLIER]));
    await deciding;
    expect(test.ready()).toMatchObject({ saving: "refused", choices: "open" });
    deciding = test.controller.decide({ kind: "extra" });
    test.decideReplies[1]?.reject(new Error("daemon gone"));
    await deciding;
    expect(test.ready().saving).toBe("failed");
    expect(test.reads).toHaveLength(2);
  });

  it("closes the choices without asking the daemon when the athlete keeps a confirmed match", async () => {
    const test = harness();
    const opening = test.controller.open();
    test.readReplies[0]?.resolve(
      rides([
        ride("a", TODAY, {
          match: { kind: "confirmed", ...ENDURANCE, outcome: "done-as-planned", by: "you" },
        }),
      ]),
    );
    await opening;
    test.controller.change();
    expect(test.ready().choices).toBe("open");
    test.controller.otherDay();
    expect(test.ready().choices).toBe("other-day");
    await test.controller.decide({ kind: "confirm", planWorkoutId: ENDURANCE.planWorkoutId });
    expect(test.ready().choices).toBe("closed");
    expect(test.decisions).toEqual([]);
  });
});
