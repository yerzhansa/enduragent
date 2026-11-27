import type { PlanCalendarRpcResult, PlanCloseResult } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createDetailsController,
  type DetailsSheetState,
  type PlanDetails,
} from "../src/calendar/details-controller";

const PLAN = "0".repeat(25) + "P";
const CHANGED = "0".repeat(24) + "12";

const DETAILS: PlanDetails = {
  status: "plan-details",
  planId: PLAN,
  version: 3,
  history: [{ kind: "saved", atMs: 884_000_000_000 }],
  ending: {
    removes: [
      {
        planWorkoutId: "0".repeat(24) + "11",
        name: "Endurance",
        dateKey: 19980114,
        durationS: 3_600,
      },
    ],
    staysToday: [],
    athleteChanges: [
      {
        planWorkoutId: CHANGED,
        name: "Long ride",
        dateKey: 19980117,
        durationS: 5_400,
        tick: { planWorkoutId: CHANGED, eventId: 7, dateKey: 19980117, fingerprint: "seen" },
      },
    ],
  },
};

function harness(
  close: PlanCloseResult | Error = {
    status: "closed",
    planId: PLAN,
    closedAt: 1,
    cleanupJobId: PLAN,
  },
) {
  const states: DetailsSheetState[] = [];
  const call = vi.fn(
    async (request: { readonly action: string }): Promise<PlanCalendarRpcResult> =>
      request.action === "plan-details" ? DETAILS : { status: "end-choice-saved" },
  );
  const closePlan = vi.fn(async () => {
    if (close instanceof Error) throw close;
    return close;
  });
  const ended = vi.fn();
  const controller = createDetailsController({
    call,
    closePlan,
    newCommandId: () => "end-command",
    ended,
    publish: (state) => states.push(state),
  });
  return { controller, states, call, closePlan, ended, last: () => states.at(-1) };
}

describe("the Plan details controller", () => {
  it("reads the details, then ends the Plan keeping the athlete's changes by default", async () => {
    const test = harness();
    await test.controller.open(PLAN);
    expect(test.last()).toEqual({ kind: "open", details: DETAILS, end: null });
    test.controller.startEnd();
    expect(test.last()).toMatchObject({ end: { kind: "idle", removeChanges: false } });
    await test.controller.confirmEnd();
    expect(test.call).toHaveBeenLastCalledWith({
      action: "save-end-choice",
      planId: PLAN,
      ticked: [],
    });
    expect(test.closePlan).toHaveBeenCalledWith({
      commandId: "end-command",
      planId: PLAN,
      expectedVersion: 3,
    });
    expect(test.last()).toEqual({ kind: "closed" });
    expect(test.ended).toHaveBeenCalledOnce();
  });

  it("removes the athlete's changes too when they tick the box", async () => {
    const test = harness();
    await test.controller.open(PLAN);
    test.controller.startEnd();
    test.controller.setRemoveChanges(true);
    await test.controller.confirmEnd();
    expect(test.call).toHaveBeenCalledWith({
      action: "save-end-choice",
      planId: PLAN,
      ticked: [DETAILS.ending.athleteChanges[0]?.tick],
    });
  });

  it.each([
    [{ status: "rejected", reason: "stale-version" } as const, "changed"],
    [new Error("offline"), "unavailable"],
  ])(
    "keeps the confirm open and puts the choice back when ending fails (%j)",
    async (reply, reason) => {
      const test = harness(reply);
      await test.controller.open(PLAN);
      test.controller.startEnd();
      test.controller.setRemoveChanges(true);
      await test.controller.confirmEnd();
      expect(test.last()).toMatchObject({ end: { kind: "failed", reason, removeChanges: true } });
      expect(test.call).toHaveBeenLastCalledWith({
        action: "save-end-choice",
        planId: PLAN,
        ticked: [],
      });
      expect(test.ended).not.toHaveBeenCalled();
    },
  );

  it("says the details could not be read, and ignores a late reply after Close", async () => {
    const failing = createDetailsController({
      call: async () => {
        throw new Error("offline");
      },
      closePlan: vi.fn(),
      newCommandId: () => "x",
      ended: vi.fn(),
      publish: vi.fn(),
    });
    const states: DetailsSheetState[] = [];
    let answer: (value: PlanCalendarRpcResult) => void = () => undefined;
    const late = createDetailsController({
      call: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      closePlan: vi.fn(),
      newCommandId: () => "x",
      ended: vi.fn(),
      publish: (state) => states.push(state),
    });
    await failing.open(PLAN);
    const opening = late.open(PLAN);
    late.close();
    answer(DETAILS);
    await opening;
    expect(states.at(-1)).toEqual({ kind: "closed" });
  });
});
