import type { CoachClient } from "@enduragent/coach-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_REVIEW_START } from "../src/activity-review/controller";
import { refreshOpenCalendarPage, startCalendarPages } from "../src/page-wiring";
import { useEnduragentStore as store } from "../src/state/store";
import { TODAY, ride, rides } from "./activity-review-fixture";

function started() {
  const call = vi.fn(
    async (
      _method: string,
      params: {
        readonly action: string;
        readonly startDateKey?: number;
        readonly endDateKey?: number;
      },
    ) =>
      params.action === "rides"
        ? rides([ride("a", TODAY)])
        : { status: "refused", reason: "no-active-plan" },
  );
  const client: CoachClient = {
    handshake: {} as CoachClient["handshake"],
    call: call as never,
    close: vi.fn(async () => undefined),
  };
  const dispose = startCalendarPages(store, {
    getClient: async () => client,
    reconnect: async () => client,
    close: async () => undefined,
  });
  const actions = () => call.mock.calls.map(([method, params]) => `${method}:${params.action}`);
  const calendarReads = () =>
    call.mock.calls.flatMap(([, params]) => (params.action === "read" ? [params] : []));
  return { dispose, actions, calendarReads };
}

afterEach(() => {
  store.setState({ activeView: "chat", activityReview: ACTIVITY_REVIEW_START });
});

describe("the Activity review wiring", () => {
  it("reads the rides when the page opens, and again after a sync while it is open", async () => {
    const test = started();
    store.getState().setActiveView("activity-review");
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"));
    expect(test.actions()).toEqual(["plan.calendar:rides"]);
    refreshOpenCalendarPage(store);
    await vi.waitFor(() => expect(test.actions()).toHaveLength(2));
    expect(test.actions()).toEqual(["plan.calendar:rides", "plan.calendar:rides"]);
    store.getState().setActiveView("chat");
    refreshOpenCalendarPage(store);
    await Promise.resolve();
    expect(test.actions()).toHaveLength(2);
    test.dispose();
    expect(store.getState().activityReviewActions).toBeNull();
  });

  it("opens the Calendar on the ride's week from Show in calendar", async () => {
    const test = started();
    store.getState().setActiveView("activity-review");
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"));
    store.getState().activityReviewActions?.showInCalendar(19980105);
    expect(store.getState().activeView).toBe("calendar");
    await vi.waitFor(() => expect(test.actions()).toContain("plan.calendar:read"));
    await vi.waitFor(() => expect(test.calendarReads()).toHaveLength(2));
    const shown = test.calendarReads().at(-1);
    expect(shown?.startDateKey).toBeLessThanOrEqual(19980105);
    expect(shown?.endDateKey).toBeGreaterThanOrEqual(19980105);
    test.dispose();
  });
});
