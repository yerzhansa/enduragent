import type { PlanCalendarRpcResult, PlanCalendarWeekStatus } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import { canDropOn, movePreview } from "../src/calendar/move";
import { createMoveController, type MoveDialogState } from "../src/calendar/move-controller";
import { calendarRead, PLAN_ID, plan, week, workout, workoutId } from "./calendar-fixture";

const MONDAY = 19980112;
const TODAY = 19980113;

function moving() {
  return calendarRead(
    TODAY,
    plan(
      MONDAY,
      [week(1, MONDAY, { plannedS: 10_800 }), week(2, 19980119, { plannedS: 7_200 })],
      [
        workout(1, 19980114, { movable: true, durationS: 3_600 }),
        workout(2, 19980117, { movable: true, durationS: 2_700 }),
        workout(3, 19980112, { movable: false }),
        workout(4, 19980121, { movable: true, durationS: 3_600, copy: { kind: "plan-only" } }),
      ],
    ),
  );
}

describe("where a workout can be dropped", () => {
  it("accepts later days inside the Plan, and refuses its own day, past days and days after the Plan", () => {
    const read = moving();
    const first = read.plan?.workouts[0];
    const done = read.plan?.workouts[2];
    if (first === undefined || done === undefined) throw new Error("fixture");
    expect(canDropOn(read, first, 19980116)).toBe(true);
    expect(canDropOn(read, first, TODAY)).toBe(true);
    expect(canDropOn(read, first, 19980114)).toBe(false);
    expect(canDropOn(read, first, 19980112)).toBe(false);
    expect(canDropOn(read, first, 19980126)).toBe(false);
    expect(canDropOn(read, done, 19980116)).toBe(false);
  });

  it("says what the move does to the weeks, with and without a swap", () => {
    const read = moving();
    expect(movePreview(read, workoutId(1), 19980116, true)).toMatchObject({
      clash: [],
      canSwap: false,
      where: { kind: "goes" },
      weeks: { kind: "same" },
    });
    const clash = movePreview(read, workoutId(1), 19980117, true);
    expect(clash?.clash.map((entry) => entry.id)).toEqual([workoutId(2)]);
    expect(movePreview(read, workoutId(4), 19980117, true)).toMatchObject({
      canSwap: true,
      weeks: { kind: "across", fromS: 7_200 - 3_600 + 2_700, toS: 10_800 + 3_600 - 2_700 },
    });
    expect(movePreview(read, workoutId(4), 19980117, false)).toMatchObject({
      weeks: { kind: "across", fromS: 3_600, toS: 14_400 },
    });
    expect(movePreview(read, "missing", 19980117, false)).toBeNull();
  });

  it("offers no swap when a workout on that day cannot move, and says when a move leaves intervals.icu", () => {
    const read = moving();
    const planned = read.plan;
    if (planned === null) throw new Error("fixture");
    const stuck = {
      ...read,
      plan: {
        ...planned,
        weeks: planned.weeks.map((entry) =>
          entry.index === 2
            ? { ...entry, status: { kind: "goes-out" as const, onDateKey: 19980119 } }
            : entry,
        ),
        workouts: planned.workouts.map((entry) =>
          entry.id === workoutId(2) ? { ...entry, movable: false } : entry,
        ),
      },
    };
    expect(movePreview(stuck, workoutId(1), 19980117, true)).toMatchObject({
      canSwap: false,
      weeks: { kind: "same", week: { index: 1 } },
    });
    expect(movePreview(stuck, workoutId(1), 19980121, false)?.where).toEqual({
      kind: "leaves",
      week: 2,
    });
  });
});

function harness(reply: PlanCalendarRpcResult | Error) {
  const states: MoveDialogState[] = [];
  const refresh = vi.fn();
  const call = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const controller = createMoveController({ call, refresh, publish: (s) => states.push(s) });
  return { controller, states, refresh, call, last: () => states.at(-1) };
}

describe("what the move dialog says happens on intervals.icu", () => {
  function withWeek2(status: PlanCalendarWeekStatus, calendarConnected = true) {
    const read = moving();
    const planned = read.plan;
    if (planned === null) throw new Error("fixture");
    return {
      ...read,
      calendarConnected,
      plan: {
        ...planned,
        weeks: planned.weeks.map((entry) => (entry.index === 2 ? { ...entry, status } : entry)),
      },
    };
  }

  it.each([
    [
      "a sent workout into a week waiting for its Approve",
      { kind: "waiting-for-week-approve" },
      true,
      1,
      { kind: "goes" },
    ],
    [
      "a sent workout while intervals.icu is not connected",
      { kind: "on-intervals" },
      false,
      1,
      { kind: "goes" },
    ],
    [
      "a sent workout into a week that has not gone out",
      { kind: "goes-out", onDateKey: 19980119 },
      true,
      1,
      { kind: "leaves", week: 2 },
    ],
    [
      "a sent workout into a week that waits to be approved later",
      { kind: "approve-from", onDateKey: 19980119 },
      true,
      1,
      { kind: "leaves", week: 2 },
    ],
    [
      "a Plan only workout into a week waiting for its Approve",
      { kind: "waiting-for-week-approve" },
      true,
      4,
      { kind: "plan-only" },
    ],
    ["a Plan only workout into a sent week", { kind: "on-intervals" }, true, 4, { kind: "goes" }],
    [
      "a Plan only workout while intervals.icu is not connected",
      { kind: "on-intervals" },
      false,
      4,
      { kind: "plan-only" },
    ],
  ] as const)("says it right for %s", (_name, status, connected, index, where) => {
    expect(
      movePreview(withWeek2(status, connected), workoutId(index), 19980122, false)?.where,
    ).toEqual(where);
  });
});

describe("the move dialog controller", () => {
  it("opens with Swap chosen, sends the move, then closes and refreshes", async () => {
    const test = harness({ status: "moved" });
    test.controller.request(PLAN_ID, workoutId(1), 19980117, true);
    expect(test.last()).toEqual({
      kind: "open",
      planId: PLAN_ID,
      workoutId: workoutId(1),
      toDateKey: 19980117,
      swap: true,
    });
    test.controller.setSwap(false);
    await test.controller.confirm(true);
    expect(test.call).toHaveBeenCalledWith({
      action: "move-workout",
      planId: PLAN_ID,
      planWorkoutId: workoutId(1),
      toDateKey: 19980117,
      swap: false,
    });
    expect(test.states.map((state) => state.kind)).toEqual(["open", "open", "moving", "closed"]);
    expect(test.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    [{ status: "refused", reason: "change-card-open" } as const, "card-open"],
    [{ status: "refused", reason: "plan-change-refused" } as const, "refused"],
    [{ status: "refused", reason: "outside-plan" } as const, "not-movable"],
    [{ status: "refused", reason: "workout-not-movable" } as const, "not-movable"],
    [new Error("offline"), "unavailable"],
  ])(
    "keeps the dialog and says nothing moved when the move comes back %j",
    async (reply, reason) => {
      const test = harness(reply);
      test.controller.request(PLAN_ID, workoutId(1), 19980117, true);
      await test.controller.confirm(true);
      expect(test.last()).toMatchObject({ kind: "failed", reason, workoutId: workoutId(1) });
      expect(test.refresh).toHaveBeenCalledOnce();
    },
  );

  it("sends Keep both when Swap is no longer possible, even after a failure", async () => {
    const test = harness({ status: "refused", reason: "workout-not-movable" });
    test.controller.request(PLAN_ID, workoutId(1), 19980117, true);
    await test.controller.confirm(true);
    expect(test.last()).toMatchObject({ kind: "failed", swap: true });
    await test.controller.confirm(false);
    expect(test.call).toHaveBeenLastCalledWith(expect.objectContaining({ swap: false }));
  });

  it("ignores Cancel and a new drop while the move is being saved", async () => {
    let answer: (value: PlanCalendarRpcResult) => void = () => undefined;
    const states: MoveDialogState[] = [];
    const controller = createMoveController({
      call: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      refresh: vi.fn(),
      publish: (state) => states.push(state),
    });
    controller.request(PLAN_ID, workoutId(1), 19980117, true);
    const saving = controller.confirm(true);
    controller.cancel();
    controller.request(PLAN_ID, workoutId(2), 19980118, true);
    expect(states.at(-1)).toMatchObject({ kind: "moving", workoutId: workoutId(1) });
    answer({ status: "moved" });
    await saving;
    expect(states.at(-1)).toEqual({ kind: "closed" });
  });
});
