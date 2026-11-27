import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import { createCalendarController, type CalendarViewState } from "../src/calendar/controller";
import { calendarRead } from "./calendar-fixture";

const TODAY = 19980114;

function harness() {
  const states: CalendarViewState[] = [];
  const requests: { startDateKey: number; endDateKey: number }[] = [];
  const replies: {
    resolve: (value: PlanCalendarRpcResult) => void;
    reject: (error: Error) => void;
  }[] = [];
  const controller = createCalendarController({
    read: (range) => {
      requests.push(range);
      return new Promise((resolve, reject) => replies.push({ resolve, reject }));
    },
    firstDayOfWeek: () => 1,
    localTodayDateKey: () => TODAY,
    publish: (state) => states.push(state),
  });
  return { controller, states, requests, replies, last: () => states.at(-1) };
}

describe("the calendar controller", () => {
  it("reads last week through two weeks ahead on open", async () => {
    const test = harness();
    const opened = test.controller.open();
    expect(test.last()).toEqual({
      kind: "loading",
      range: { firstRowStart: 19980105, rowCount: 4 },
    });
    expect(test.requests).toEqual([{ startDateKey: 19980105, endDateKey: 19980201 }]);
    test.replies[0]?.resolve(calendarRead(TODAY, null));
    await opened;
    expect(test.last()).toMatchObject({ kind: "ready", refresh: "idle" });
  });

  it("keeps only the newest reply when the athlete moves before a read returns", async () => {
    const test = harness();
    const first = test.controller.open();
    const second = test.controller.next();
    test.replies[1]?.resolve(calendarRead(TODAY, null));
    await second;
    test.replies[0]?.resolve(calendarRead(19980101, null));
    await first;
    expect(test.last()).toMatchObject({
      kind: "ready",
      read: { todayDateKey: TODAY },
      range: { firstRowStart: 19980112 },
    });
  });

  it("shows unavailable when the first read fails, and keeps the last calendar when a refresh fails", async () => {
    const test = harness();
    const first = test.controller.open();
    test.replies[0]?.reject(new Error("offline"));
    await first;
    expect(test.last()).toEqual({
      kind: "unavailable",
      range: { firstRowStart: 19980105, rowCount: 4 },
    });
    const retry = test.controller.refresh();
    test.replies[1]?.resolve(calendarRead(TODAY, null));
    await retry;
    const refresh = test.controller.refresh();
    expect(test.last()).toMatchObject({ kind: "ready", refresh: "refreshing" });
    test.replies[2]?.resolve({ status: "refused", reason: "no-active-plan" });
    await refresh;
    expect(test.last()).toMatchObject({ kind: "ready", refresh: "failed" });
  });

  it("returns to today's rows and jumps to a chosen week", async () => {
    const test = harness();
    void test.controller.previous();
    void test.controller.today();
    void test.controller.showWeekOf(19980126);
    expect(test.requests.map((request) => request.startDateKey)).toEqual([
      19971229, 19980105, 19980119,
    ]);
  });

  it("keeps showing the last read's rows until the next read lands, and after it fails", async () => {
    const test = harness();
    const first = test.controller.open();
    test.replies[0]?.resolve(calendarRead(TODAY, null));
    await first;
    const next = test.controller.next();
    expect(test.last()).toMatchObject({
      kind: "ready",
      refresh: "refreshing",
      range: { firstRowStart: 19980105 },
    });
    test.replies[1]?.reject(new Error("offline"));
    await next;
    expect(test.last()).toMatchObject({
      kind: "ready",
      refresh: "failed",
      range: { firstRowStart: 19980105 },
    });
    void test.controller.refresh();
    expect(test.requests.at(-1)?.startDateKey).toBe(19980112);
    void test.controller.open();
    expect(test.requests.at(-1)?.startDateKey).toBe(19980105);
  });
});
