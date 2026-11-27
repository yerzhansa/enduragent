import { PlanCalendarStatusSchema, type PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  approvalFor,
  approvedWeeks,
  firstApproval,
  opensCalendarAfterActivate,
  sendingFailures,
  weekApprovals,
} from "../src/calendar/approval";
import {
  createApproveController,
  SENDING_POLLS,
  type ApproveSheetState,
} from "../src/calendar/approve-controller";
import {
  createCalendarSettingsController,
  type CalendarSettingsState,
} from "../src/calendar/settings-controller";
import { calendarRead, plan, week, workout } from "./calendar-fixture";

const MONDAY = 19980105;

function waitingRead(today = 19980107) {
  return calendarRead(
    today,
    plan(
      MONDAY,
      [
        week(1, MONDAY, { status: { kind: "waiting-for-first-approve" } }),
        week(2, 19980112, { status: { kind: "waiting-for-first-approve" } }),
        week(3, 19980119, { status: { kind: "goes-out", onDateKey: 19980112 } }),
      ],
      [
        workout(1, MONDAY, { copy: { kind: "plan-only" } }),
        workout(2, 19980108, { copy: { kind: "plan-only" } }),
        workout(3, 19980113, { copy: { kind: "plan-only" } }),
        workout(4, 19980115, { copy: { kind: "plan-only" }, outcome: { kind: "removed-by-you" } }),
        workout(5, 19980120, { copy: { kind: "plan-only" } }),
      ],
    ),
  );
}

function sentRead(lastWrite: "ok" | "failed" | "none") {
  const read = waitingRead();
  const planned = read.plan;
  if (planned === null) throw new Error("plan");
  return {
    ...read,
    plan: {
      ...planned,
      weeks: planned.weeks.map((entry) =>
        entry.index < 3 ? { ...entry, status: { kind: "on-intervals" as const } } : entry,
      ),
      workouts: planned.workouts.map((entry) =>
        entry.dateKey === 19980113 && lastWrite !== "ok"
          ? { ...entry, lastWrite }
          : entry.dateKey < 19980119
            ? { ...entry, copy: { kind: "on-intervals" as const, owner: "plan" as const } }
            : entry,
      ),
    },
  };
}

describe("what the Approve sheet lists", () => {
  it("lists this week's and next week's workouts from today that are not on intervals.icu yet", () => {
    const pending = firstApproval(waitingRead());
    expect(pending?.scope).toEqual({ kind: "first-weeks" });
    expect(
      pending?.weeks.map((entry) => [entry.week.index, entry.workouts.map((w) => w.dateKey)]),
    ).toEqual([
      [1, [19980108]],
      [2, [19980113]],
    ]);
    expect(pending?.count).toBe(2);
    expect(pending?.totalS).toBe(7_200);
    expect(weekApprovals(waitingRead())).toEqual([]);
  });

  it("offers a later week on its own when Approve each week holds it", () => {
    const read = waitingRead();
    const planned = read.plan;
    if (planned === null) throw new Error("plan");
    const held = {
      ...read,
      plan: {
        ...planned,
        weeks: planned.weeks.map((entry) =>
          entry.index === 3
            ? { ...entry, status: { kind: "waiting-for-week-approve" as const } }
            : { ...entry, status: { kind: "on-intervals" as const } },
        ),
      },
    };
    expect(firstApproval(held)).toBeNull();
    expect(weekApprovals(held).map((pending) => pending.scope)).toEqual([
      { kind: "week", week: 3 },
    ]);
    expect(approvalFor(held, { kind: "week", week: 3 })?.count).toBe(1);
  });

  it("follows the approved weeks while they are sent, and names the failed days", () => {
    const sending = sendingFailures(sentRead("none"), [1, 2]);
    expect(sending.sent).toBe(1);
    expect(sending.waiting.map((entry) => entry.dateKey)).toEqual([19980113]);
    const failed = sendingFailures(sentRead("failed"), [1, 2]);
    expect(failed.sent).toBe(1);
    expect(failed.failed.map((entry) => entry.dateKey)).toEqual([19980113]);
    expect(approvedWeeks(sentRead("ok"), { kind: "first-weeks" }, [1, 2])?.count).toBe(2);
  });
});

function approveHarness(reply: PlanCalendarRpcResult | Error) {
  const states: ApproveSheetState[] = [];
  const later: (() => void)[] = [];
  const cancelled = vi.fn();
  const order: string[] = [];
  const refresh = vi.fn(() => {
    order.push("refresh");
  });
  const approve = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const sendAgain = vi.fn(async (): Promise<PlanCalendarRpcResult> => {
    order.push("send-again");
    return { status: "sending" };
  });
  const libraryChanged = vi.fn();
  const controller = createApproveController({
    approve,
    sendAgain,
    libraryChanged,
    refresh,
    later: (run) => {
      later.push(run);
      return cancelled;
    },
    publish: (state) => states.push(state),
  });
  return {
    controller,
    states,
    later,
    cancelled,
    order,
    refresh,
    approve,
    libraryChanged,
    sendAgain,
    last: () => states.at(-1),
  };
}

describe("opening the Calendar after Activate", () => {
  const status = (calendar: Record<string, unknown>) => ({
    window: null,
    currentThrough: null,
    error: null,
    ...calendar,
  });
  it.each([
    ["when the new Plan waits for Approve", status({ status: "waiting-for-approve" }), true],
    [
      "when an old Plan's cleanup failed while the new Plan waits",
      status({
        status: "failed",
        error: "Calendar cleanup failed. Retry available.",
        waitingForApprove: true,
      }),
      true,
    ],
    ["not when the new Plan was already approved", status({ status: "pending" }), false],
  ] as const)("opens it %s", (_name, calendar, opens) => {
    expect(
      opensCalendarAfterActivate(
        { planId: "0".repeat(25) + "A" },
        { planId: "0".repeat(25) + "B", calendar: PlanCalendarStatusSchema.parse(calendar) },
      ),
    ).toBe(opens);
  });

  it("does not open it for the same Plan", () => {
    expect(
      opensCalendarAfterActivate(
        { planId: "0".repeat(25) + "A" },
        {
          planId: "0".repeat(25) + "A",
          calendar: PlanCalendarStatusSchema.parse(status({ status: "waiting-for-approve" })),
        },
      ),
    ).toBe(false);
  });
});

const TICK = {
  planWorkoutId: "0".repeat(24) + "77",
  eventId: 707,
  dateKey: 19980110,
  fingerprint: "icu:edited",
};

function replacingRead(
  cleanup: "held" | "pending" | "running" | "failed",
  removes: readonly number[] = [19980108, 19980109],
) {
  return {
    ...waitingRead(),
    replacing: {
      planName: "Old base",
      cleanup,
      removes: removes.map((dateKey, index) => ({
        planWorkoutId: "0".repeat(24) + String(60 + index),
        name: `Old ride ${index + 1}`,
        dateKey,
        durationS: 3_600,
      })),
      staysToday: [],
      athleteChanges: [
        {
          planWorkoutId: TICK.planWorkoutId,
          name: "My own ride",
          dateKey: TICK.dateKey,
          durationS: 5_400,
          tick: TICK,
        },
      ],
    },
  };
}

describe("the Replace Approve", () => {
  it("sends the ticked changes, follows the removal, then the new weeks", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(replacingRead("held"), "idle");
    expect(test.last()).toEqual({ kind: "open", scope: { kind: "first-weeks" } });
    test.controller.setRemoveChanges(true);
    expect(test.last()).toEqual({
      kind: "open",
      scope: { kind: "first-weeks" },
      removeChanges: true,
    });
    await test.controller.approve();
    expect(test.approve).toHaveBeenCalledWith({
      planId: waitingRead().plan?.planId,
      scope: { kind: "first-weeks" },
      ticked: [TICK],
    });
    expect(test.last()).toMatchObject({ kind: "sending", removing: 3, polls: 0 });
    test.controller.observe(replacingRead("running", [19980109]), "idle");
    expect(test.last()).toMatchObject({ kind: "sending", removing: 3, polls: 1 });
    test.controller.observe(replacingRead("failed", [19980109]), "idle");
    expect(test.last()).toMatchObject({ kind: "remove-failed", removing: 3, weeks: [1, 2] });
    test.order.length = 0;
    await test.controller.retry();
    expect(test.order).toEqual(["send-again", "refresh"]);
    expect(test.last()).toMatchObject({ kind: "sending", removing: 3, polls: 0 });
    test.controller.observe({ ...sentRead("none"), replacing: null }, "idle");
    expect(test.last()).toMatchObject({ kind: "sending", polls: 1 });
    test.controller.observe({ ...sentRead("ok"), replacing: null }, "idle");
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it("keeps the athlete's changes unless they tick them, and moves on once the removal is done", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(replacingRead("held"), "idle");
    test.controller.setRemoveChanges(true);
    test.controller.setRemoveChanges(false);
    await test.controller.approve();
    expect(test.approve).toHaveBeenCalledWith(expect.objectContaining({ ticked: [] }));
    expect(test.last()).toMatchObject({ kind: "sending", removing: 2 });
    test.controller.observe(replacingRead("failed"), "idle");
    expect(test.last()).toMatchObject({ kind: "remove-failed" });
    test.controller.observe({ ...sentRead("none"), replacing: null }, "idle");
    expect(test.last()).toMatchObject({ kind: "sending", removing: 2, polls: 0 });
  });

  it("says the removal failed when it is still not done after every poll", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(replacingRead("held"), "idle");
    await test.controller.approve();
    for (let poll = 0; poll <= SENDING_POLLS; poll += 1) {
      test.controller.observe(replacingRead("pending"), "idle");
    }
    expect(test.last()).toMatchObject({ kind: "remove-failed", removing: 2 });
  });
});

describe("the Approve controller", () => {
  it("opens for a new Plan, approves, and closes once both weeks are on intervals.icu", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead(), "idle");
    expect(test.last()).toEqual({ kind: "open", scope: { kind: "first-weeks" } });
    await test.controller.approve();
    expect(test.approve).toHaveBeenCalledWith({
      planId: waitingRead().plan?.planId,
      scope: { kind: "first-weeks" },
      ticked: [],
    });
    expect(test.last()).toMatchObject({ kind: "sending", weeks: [1, 2] });
    expect(test.refresh).toHaveBeenCalledOnce();
    expect(test.libraryChanged).toHaveBeenCalledOnce();
    test.controller.observe(sentRead("none"), "idle");
    expect(test.last()).toMatchObject({ kind: "sending", polls: 1 });
    test.later.at(-1)?.();
    expect(test.refresh).toHaveBeenCalledTimes(2);
    test.controller.observe(sentRead("ok"), "idle");
    expect(test.last()).toEqual({ kind: "closed" });
    expect(test.libraryChanged).toHaveBeenCalledTimes(2);
  });

  it("shows failed writes, and Retry asks the app to send again before it reads", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead(), "idle");
    await test.controller.approve();
    test.controller.observe(sentRead("failed"), "idle");
    expect(test.last()).toMatchObject({ kind: "send-failed", weeks: [1, 2] });
    test.order.length = 0;
    await test.controller.retry();
    expect(test.sendAgain).toHaveBeenCalledOnce();
    expect(test.order).toEqual(["send-again", "refresh"]);
    expect(test.last()).toMatchObject({ kind: "sending", polls: 0 });
    test.controller.observe(sentRead("ok"), "idle");
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it("keeps the sheet open with the unsent workouts when sending takes too long", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead(), "idle");
    await test.controller.approve();
    for (let poll = 0; poll < SENDING_POLLS; poll += 1) {
      test.controller.observe(sentRead("none"), "idle");
    }
    expect(test.last()).toMatchObject({ kind: "sending", polls: SENDING_POLLS });
    test.controller.observe(sentRead("none"), "idle");
    expect(test.last()).toMatchObject({ kind: "send-failed", weeks: [1, 2] });
    expect(test.libraryChanged).toHaveBeenCalledTimes(2);
    test.controller.observe(sentRead("ok"), "idle");
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it("does not spend a poll on a read that is still refreshing, and counts a failed refresh", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead(), "idle");
    await test.controller.approve();
    test.controller.observe(waitingRead(), "refreshing");
    expect(test.last()).toMatchObject({ kind: "sending", polls: 0 });
    test.controller.observe(waitingRead(), "failed");
    expect(test.last()).toMatchObject({ kind: "sending", polls: 1 });
    for (let poll = 1; poll < SENDING_POLLS; poll += 1) {
      test.controller.observe(waitingRead(), "failed");
    }
    test.controller.observe(waitingRead(), "failed");
    expect(test.last()).toMatchObject({ kind: "send-failed" });
  });

  it("ignores Not now while the Approve call is running", async () => {
    let answer: (value: PlanCalendarRpcResult) => void = () => undefined;
    const states: ApproveSheetState[] = [];
    const controller = createApproveController({
      approve: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      sendAgain: async () => ({ status: "sending" }),
      libraryChanged: vi.fn(),
      refresh: vi.fn(),
      later: () => vi.fn(),
      publish: (state) => states.push(state),
    });
    controller.observe(waitingRead(), "idle");
    const approving = controller.approve();
    controller.notNow();
    expect(states.at(-1)).toEqual({ kind: "approving", scope: { kind: "first-weeks" } });
    answer({ status: "approved", weeks: [1, 2] });
    await approving;
    expect(states.at(-1)).toMatchObject({ kind: "sending" });
  });

  it("closes a refused sheet once nothing is left to approve, so later banners still show", async () => {
    const test = approveHarness({ status: "refused", reason: "already-approved" });
    test.controller.observe(waitingRead(), "idle");
    await test.controller.approve();
    expect(test.last()).toEqual({ kind: "refused", scope: { kind: "first-weeks" } });
    test.controller.observe(sentRead("ok"), "idle");
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it("stops its poll timer when the page goes away", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead(), "idle");
    await test.controller.approve();
    test.controller.dispose();
    expect(test.cancelled).toHaveBeenCalled();
    const published = test.states.length;
    test.controller.observe(sentRead("ok"), "idle");
    expect(test.states).toHaveLength(published);
  });

  it("keeps Not now until the page opens again", () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead(), "idle");
    test.controller.notNow();
    test.controller.observe(waitingRead(), "idle");
    expect(test.last()).toEqual({ kind: "closed" });
    test.controller.pageOpened();
    test.controller.observe(waitingRead(), "idle");
    expect(test.last()).toEqual({ kind: "open", scope: { kind: "first-weeks" } });
  });

  it("says the Change Set is out of date when the app refuses it, and reopens on a failed call", async () => {
    const refused = approveHarness({ status: "refused", reason: "already-approved" });
    refused.controller.observe(waitingRead(), "idle");
    await refused.controller.approve();
    expect(refused.last()).toEqual({ kind: "refused", scope: { kind: "first-weeks" } });
    expect(refused.libraryChanged).not.toHaveBeenCalled();
    const offline = approveHarness(new Error("offline"));
    offline.controller.observe(waitingRead(), "idle");
    await offline.controller.approve();
    expect(offline.last()).toEqual({ kind: "open", scope: { kind: "first-weeks" } });
  });
});

describe("Calendar settings", () => {
  it("reads both switches and saves each one, putting it back when a save fails", async () => {
    const states: CalendarSettingsState[] = [];
    const saveSettings = vi
      .fn<(value: "send-each-week" | "approve-each-week") => Promise<PlanCalendarRpcResult>>()
      .mockResolvedValueOnce({ status: "settings", weekDelivery: "approve-each-week" });
    const setStartAtLogin = vi
      .fn<(enabled: boolean) => Promise<{ kind: "known"; enabled: boolean }>>()
      .mockRejectedValueOnce(new Error("busy"));
    const controller = createCalendarSettingsController({
      readSettings: async () => ({ status: "settings", weekDelivery: "send-each-week" }),
      saveSettings,
      readStartAtLogin: async () => ({ kind: "known", enabled: false }),
      setStartAtLogin,
      publish: (state) => states.push(state),
    });
    await controller.load();
    expect(states.at(-1)).toEqual({
      weekDelivery: { kind: "ready", value: "send-each-week" },
      startAtLogin: { kind: "ready", enabled: false },
    });
    await controller.setWeekDelivery("approve-each-week");
    expect(states.at(-1)?.weekDelivery).toEqual({ kind: "ready", value: "approve-each-week" });
    await controller.setStartAtLogin(true);
    expect(states.at(-1)?.startAtLogin).toEqual({ kind: "ready", enabled: false });
  });
});
