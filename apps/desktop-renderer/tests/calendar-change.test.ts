import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import { calendarRead, plan, week, workout } from "./calendar-fixture";
import { intervalsChanges, calendarRows } from "../src/calendar/grid";
import {
  createChangeController,
  type ChangeDetail,
  type ChangeSheetState,
} from "../src/calendar/change-controller";

const PLAN = "0".repeat(25) + "P";
const WORKOUT = "0".repeat(24) + "11";

const DETAIL: ChangeDetail = {
  status: "change-detail",
  planWorkoutId: WORKOUT,
  change: "edited",
  plan: { dateKey: 19980114, name: "Endurance 1", durationS: 3_600, description: null },
  intervals: { dateKey: 19980114, name: "Endurance 1", durationS: 2_700, description: null },
  editedAt: null,
};

function harness(replies: readonly (PlanCalendarRpcResult | Error)[]) {
  const states: ChangeSheetState[] = [];
  const queue = [...replies];
  const call = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("no reply");
    if (next instanceof Error) throw next;
    return next;
  });
  const refresh = vi.fn();
  const controller = createChangeController({
    call,
    refresh,
    publish: (state) => states.push(state),
  });
  return { controller, states, call, refresh, last: () => states.at(-1) };
}

describe("the change card controller", () => {
  it("reads the workout from intervals.icu, then keeps the athlete's version and refreshes", async () => {
    const test = harness([DETAIL, { status: "change-resolved", outcome: "kept" }]);
    await test.controller.open(PLAN, WORKOUT);
    expect(test.states.map((state) => state.kind)).toEqual(["loading", "open"]);
    expect(test.call).toHaveBeenLastCalledWith({
      action: "change-detail",
      planId: PLAN,
      planWorkoutId: WORKOUT,
    });
    await test.controller.keep();
    expect(test.call).toHaveBeenLastCalledWith({
      action: "keep-change",
      planId: PLAN,
      planWorkoutId: WORKOUT,
    });
    expect(test.states.map((state) => state.kind)).toEqual([
      "loading",
      "open",
      "working",
      "closed",
    ]);
    expect(test.refresh).toHaveBeenCalledOnce();
  });

  it("shows the newest version first when the workout changed again before Put back", async () => {
    const newer: ChangeDetail = {
      ...DETAIL,
      intervals: {
        ...DETAIL.intervals,
        dateKey: 19980114,
        name: "Endurance 1",
        durationS: 1_800,
        description: null,
      },
    };
    const test = harness([DETAIL, { status: "change-resolved", outcome: "refreshed" }, newer]);
    await test.controller.open(PLAN, WORKOUT);
    await test.controller.putBack();
    expect(test.call).toHaveBeenNthCalledWith(2, {
      action: "put-back",
      planId: PLAN,
      planWorkoutId: WORKOUT,
    });
    expect(test.last()).toEqual({ kind: "open", planId: PLAN, detail: newer });
    expect(test.refresh).toHaveBeenCalledOnce();
  });

  it("closes when the card is already gone, as when the athlete changed it back", async () => {
    const test = harness([{ status: "change-resolved", outcome: "no-card" }]);
    await test.controller.open(PLAN, WORKOUT);
    expect(test.last()).toEqual({ kind: "closed" });
    expect(test.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the card with the reason when a choice fails, and lets the athlete choose again", async () => {
    const test = harness([
      DETAIL,
      new Error("offline"),
      { status: "refused", reason: "plan-change-refused" },
      { status: "change-resolved", outcome: "put-back" },
    ]);
    await test.controller.open(PLAN, WORKOUT);
    await test.controller.keep();
    expect(test.last()).toMatchObject({ kind: "failed", reason: "unavailable" });
    await test.controller.keep();
    expect(test.last()).toMatchObject({ kind: "failed", reason: "refused" });
    await test.controller.putBack();
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it("says it could not read the workout, and ignores a reply that arrives after Close", async () => {
    const failing = harness([{ status: "refused", reason: "intervals-unavailable" }]);
    await failing.controller.open(PLAN, WORKOUT);
    expect(failing.last()).toEqual({ kind: "unavailable", planId: PLAN, planWorkoutId: WORKOUT });

    let answer: (value: PlanCalendarRpcResult) => void = () => undefined;
    const states: ChangeSheetState[] = [];
    const controller = createChangeController({
      call: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      refresh: vi.fn(),
      publish: (state) => states.push(state),
    });
    const opening = controller.open(PLAN, WORKOUT);
    controller.close();
    answer(DETAIL);
    await opening;
    expect(states.at(-1)).toEqual({ kind: "closed" });
  });

  it("does nothing on Keep or Put back while no card is open", async () => {
    const test = harness([]);
    await test.controller.keep();
    await test.controller.putBack();
    expect(test.call).not.toHaveBeenCalled();
    expect(test.states).toEqual([]);
  });
});

describe("counting and placing changes", () => {
  it("counts each kind and shows a moved workout on its new day too", () => {
    const read = calendarRead(
      19980113,
      plan(
        19980112,
        [week(1, 19980112)],
        [
          workout(1, 19980114, {
            copy: {
              kind: "changed-in-intervals",
              change: "edited",
              toDateKey: null,
              name: null,
              durationS: 1_800,
            },
          }),
          workout(2, 19980115, {
            copy: {
              kind: "changed-in-intervals",
              change: "moved",
              toDateKey: 19980116,
              name: null,
              durationS: null,
            },
          }),
        ],
      ),
    );
    expect(intervalsChanges(read)).toEqual({ edited: 1, moved: 1, deleted: 0 });
    const days = calendarRows(read, { firstRowStart: 19980112, rowCount: 1 })[0]?.days ?? [];
    expect(days.find((day) => day.dateKey === 19980115)?.workouts.map((entry) => entry.id)).toEqual(
      ["0".repeat(24) + "12"],
    );
    expect(days.find((day) => day.dateKey === 19980116)?.movedIn.map((entry) => entry.id)).toEqual([
      "0".repeat(24) + "12",
    ]);
  });
});
