import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  approvalFor,
  approvedWeeks,
  firstApproval,
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
    expect(sendingFailures(sentRead("none"), [1, 2])).toMatchObject({ sent: 1, waiting: 1 });
    const failed = sendingFailures(sentRead("failed"), [1, 2]);
    expect(failed.sent).toBe(1);
    expect(failed.failed.map((entry) => entry.dateKey)).toEqual([19980113]);
    expect(approvedWeeks(sentRead("ok"), { kind: "first-weeks" }, [1, 2])?.count).toBe(2);
  });
});

function approveHarness(reply: PlanCalendarRpcResult | Error) {
  const states: ApproveSheetState[] = [];
  const later: (() => void)[] = [];
  const refresh = vi.fn();
  const approve = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const controller = createApproveController({
    approve,
    refresh,
    later: (run) => later.push(run),
    publish: (state) => states.push(state),
  });
  return { controller, states, later, refresh, approve, last: () => states.at(-1) };
}

describe("the Approve controller", () => {
  it("opens for a new Plan, approves, and closes once both weeks are on intervals.icu", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead());
    expect(test.last()).toEqual({ kind: "open", scope: { kind: "first-weeks" } });
    await test.controller.approve();
    expect(test.approve).toHaveBeenCalledWith({
      planId: waitingRead().plan?.planId,
      scope: { kind: "first-weeks" },
    });
    expect(test.last()).toMatchObject({ kind: "sending", weeks: [1, 2] });
    expect(test.refresh).toHaveBeenCalledOnce();
    test.controller.observe(sentRead("none"));
    expect(test.last()).toMatchObject({ kind: "sending", polls: 1 });
    test.later.at(-1)?.();
    expect(test.refresh).toHaveBeenCalledTimes(2);
    test.controller.observe(sentRead("ok"));
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it("shows failed writes with Retry, and stops polling after a while", async () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead());
    await test.controller.approve();
    test.controller.observe(sentRead("failed"));
    expect(test.last()).toMatchObject({ kind: "send-failed", weeks: [1, 2] });
    test.controller.retry();
    expect(test.last()).toMatchObject({ kind: "sending", polls: 0 });
    for (let poll = 0; poll < SENDING_POLLS; poll += 1) test.controller.observe(sentRead("none"));
    test.controller.observe(sentRead("none"));
    expect(test.last()).toEqual({ kind: "closed" });
  });

  it("keeps Not now until the page opens again", () => {
    const test = approveHarness({ status: "approved", weeks: [1, 2] });
    test.controller.observe(waitingRead());
    test.controller.notNow();
    test.controller.observe(waitingRead());
    expect(test.last()).toEqual({ kind: "closed" });
    test.controller.pageOpened();
    test.controller.observe(waitingRead());
    expect(test.last()).toEqual({ kind: "open", scope: { kind: "first-weeks" } });
  });

  it("says the Change Set is out of date when the app refuses it, and reopens on a failed call", async () => {
    const refused = approveHarness({ status: "refused", reason: "already-approved" });
    refused.controller.observe(waitingRead());
    await refused.controller.approve();
    expect(refused.last()).toEqual({ kind: "refused", scope: { kind: "first-weeks" } });
    const offline = approveHarness(new Error("offline"));
    offline.controller.observe(waitingRead());
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
