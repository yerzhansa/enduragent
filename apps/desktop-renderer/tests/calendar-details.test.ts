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

const TICK = DETAILS.ending.athleteChanges[0]?.tick;

type Reply<T> = T | Error | (() => Promise<T>);

function harness(
  options: {
    readonly close?: readonly Reply<PlanCloseResult>[];
    readonly save?: readonly Reply<PlanCalendarRpcResult>[];
  } = {},
) {
  const states: DetailsSheetState[] = [];
  const closes = [...(options.close ?? [])];
  const saves = [...(options.save ?? [])];
  const answer = async <T>(queue: Reply<T>[], fallback: T): Promise<T> => {
    const next = queue.shift() ?? fallback;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? (next as () => Promise<T>)() : next;
  };
  const call = vi.fn(
    async (request: { readonly action: string }): Promise<PlanCalendarRpcResult> =>
      request.action === "plan-details"
        ? DETAILS
        : answer<PlanCalendarRpcResult>(saves, { status: "end-choice-saved" }),
  );
  const closePlan = vi.fn(async (_request: { readonly commandId: string }) =>
    answer<PlanCloseResult>(closes, {
      status: "closed",
      planId: PLAN,
      closedAt: 1,
      cleanupJobId: PLAN,
    }),
  );
  const ended = vi.fn();
  let commands = 0;
  const controller = createDetailsController({
    call,
    closePlan,
    newCommandId: () => `end-command-${++commands}`,
    ended,
    publish: (state) => states.push(state),
  });
  return { controller, states, call, closePlan, ended, last: () => states.at(-1) };
}

const saves = (call: ReturnType<typeof harness>["call"]) =>
  call.mock.calls.filter(([request]) => request.action === "save-end-choice");

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
      commandId: "end-command-1",
      ticked: [],
    });
    expect(test.closePlan).toHaveBeenCalledWith({
      commandId: "end-command-1",
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
      commandId: "end-command-1",
      ticked: [TICK],
    });
  });

  it("says the Plan changed meanwhile when the close is rejected, and saves the choice once", async () => {
    const test = harness({ close: [{ status: "rejected", reason: "stale-version" }] });
    await test.controller.open(PLAN);
    test.controller.startEnd();
    test.controller.setRemoveChanges(true);
    await test.controller.confirmEnd();
    expect(test.last()).toMatchObject({
      end: { kind: "failed", reason: "changed", removeChanges: true },
    });
    expect(saves(test.call)).toHaveLength(1);
    expect(test.ended).not.toHaveBeenCalled();
  });

  it("retries an unconfirmed End with the same command and the same choice, which it locks", async () => {
    const test = harness({ close: [new Error("offline")] });
    await test.controller.open(PLAN);
    test.controller.startEnd();
    test.controller.setRemoveChanges(true);
    await test.controller.confirmEnd();
    expect(test.last()).toMatchObject({
      end: { kind: "failed", reason: "unconfirmed", removeChanges: true },
    });
    test.controller.setRemoveChanges(false);
    expect(test.last()).toMatchObject({ end: { removeChanges: true } });
    await test.controller.confirmEnd();
    expect(test.closePlan.mock.calls.map(([request]) => request.commandId)).toEqual([
      "end-command-1",
      "end-command-1",
    ]);
    expect(saves(test.call).map(([request]) => request)).toEqual([
      { action: "save-end-choice", planId: PLAN, commandId: "end-command-1", ticked: [TICK] },
      { action: "save-end-choice", planId: PLAN, commandId: "end-command-1", ticked: [TICK] },
    ]);
    expect(test.last()).toEqual({ kind: "closed" });
    expect(test.ended).toHaveBeenCalledOnce();
  });

  it("counts a replayed close as ended when the first close went through but its reply was lost", async () => {
    const test = harness({
      close: [new Error("reply lost")],
      save: [{ status: "end-choice-saved" }, { status: "refused", reason: "no-active-plan" }],
    });
    await test.controller.open(PLAN);
    test.controller.startEnd();
    await test.controller.confirmEnd();
    await test.controller.confirmEnd();
    expect(test.closePlan).toHaveBeenCalledTimes(2);
    expect(test.last()).toEqual({ kind: "closed" });
    expect(test.ended).toHaveBeenCalledOnce();
  });

  it("does not close when the choice could not be saved for another reason", async () => {
    const test = harness({ save: [{ status: "refused", reason: "plan-change-refused" }] });
    await test.controller.open(PLAN);
    test.controller.startEnd();
    await test.controller.confirmEnd();
    expect(test.closePlan).not.toHaveBeenCalled();
    expect(test.last()).toMatchObject({ end: { kind: "failed", reason: "unconfirmed" } });
  });

  it("ignores a second End, Close and Open while the Plan is ending", async () => {
    let finish: (value: PlanCloseResult) => void = () => undefined;
    const pending = () =>
      new Promise<PlanCloseResult>((resolve) => {
        finish = resolve;
      });
    const test = harness({ close: [pending] });
    await test.controller.open(PLAN);
    test.controller.startEnd();
    const ending = test.controller.confirmEnd();
    await vi.waitFor(() => expect(test.closePlan).toHaveBeenCalledOnce());
    await test.controller.confirmEnd();
    test.controller.close();
    await test.controller.open(PLAN);
    expect(test.last()).toMatchObject({ kind: "open", end: { kind: "ending" } });
    finish({ status: "closed", planId: PLAN, closedAt: 1, cleanupJobId: PLAN });
    await ending;
    expect(test.closePlan).toHaveBeenCalledOnce();
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it.each([
    ["the app does not answer", new Error("offline")],
    ["the Plan is gone", { status: "refused", reason: "no-active-plan" } as const],
  ])("says the details could not be read when %s", async (_name, reply) => {
    const states: DetailsSheetState[] = [];
    const controller = createDetailsController({
      call: async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      },
      closePlan: vi.fn(),
      newCommandId: () => "x",
      ended: vi.fn(),
      publish: (state) => states.push(state),
    });
    await controller.open(PLAN);
    expect(states.at(-1)).toEqual({ kind: "unavailable", planId: PLAN });
  });

  it("ignores a late reply after Close", async () => {
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
    const opening = late.open(PLAN);
    late.close();
    answer(DETAILS);
    await opening;
    expect(states.at(-1)).toEqual({ kind: "closed" });
  });
});
